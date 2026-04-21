import express from 'express';
import { fork } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));
import cors from 'cors';
import { ZkProgram, PublicKey, PrivateKey, Signature, Field, Struct, Mina, AccountUpdate, fetchAccount } from 'o1js';
import Client from 'mina-signer';
import { createHash } from 'crypto';

const app  = express();
const PORT = process.env.PORT || 3000;

const SERVER_PRIVATE_KEY = process.env.SERVER_PRIVATE_KEY;
const SERVER_PUBLIC_KEY  = process.env.SERVER_PUBLIC_KEY;

if (!SERVER_PRIVATE_KEY) {
  console.error('FATAL: SERVER_PRIVATE_KEY env var is not set.');
  console.error('Set it in Railway Variables. Refusing to start without it — the');
  console.error('attesting server key is what signs verifications and must never be');
  console.error('hardcoded in source. See README for rotation instructions.');
  process.exit(1);
}
if (!SERVER_PUBLIC_KEY) {
  console.error('FATAL: SERVER_PUBLIC_KEY env var is not set.');
  console.error('Set it in Railway Variables to the B62q... address that matches');
  console.error('SERVER_PRIVATE_KEY. Refusing to start without it.');
  process.exit(1);
}

// Sanity check: confirm the private key actually produces the configured public key.
// Catches the "one env var updated, the other forgotten" failure mode where the
// server would otherwise happily sign attestations with the wrong key pair.
try {
  const derived = PrivateKey.fromBase58(SERVER_PRIVATE_KEY).toPublicKey().toBase58();
  if (derived !== SERVER_PUBLIC_KEY) {
    console.error('FATAL: SERVER_PUBLIC_KEY does not match SERVER_PRIVATE_KEY.');
    console.error('  Configured public key:', SERVER_PUBLIC_KEY);
    console.error('  Derived from private :', derived);
    console.error('One of the two env vars is stale. Update Railway and redeploy.');
    process.exit(1);
  }
  console.log('Server key pair verified. Public key:', SERVER_PUBLIC_KEY);
} catch (e) {
  console.error('FATAL: SERVER_PRIVATE_KEY is not a valid Mina private key:', e.message);
  process.exit(1);
}

// The verification key hash for the currently-deployed circuit. After compile()
// runs we sanity-check that the live hash matches this constant. If the circuit
// ever changes (intentionally or by accident — e.g. unpinned o1js version drift),
// the mismatch is logged loudly so the issue can't silently break verification.
//
// IMPORTANT: This hash is tied to BOTH the circuit source AND the o1js version.
// Bumping o1js (even a patch) can change this hash because Pickles internals
// shift between versions. Always pin o1js to an EXACT version in package.json
// (no caret, no tilde) and commit package-lock.json so deploys can't drift.
//
// If you intentionally bump o1js or change the circuit:
//   1. Deploy and read the new hash from Railway logs / /health endpoint
//   2. Update this constant
//   3. Update VERIFICATION_KEY_HASH in supabase/functions/zk-attest/index.ts
//   4. Update VK_HASH in verify.html (audit-the-circuit instructions)
//   5. Existing user proofs will not verify against the new VK — wipe and re-verify
const EXPECTED_VK_HASH = '21428822038759506179445837352223957273759843165645580082852926175852620820809';

const minaClient = new Client({ network: 'mainnet' });

app.use(cors({ origin: ['https://play.minaliens.xyz', 'http://localhost', 'http://127.0.0.1'], credentials: false }));
app.use(express.json());

// ── ZkProgram ──
class VerificationPublicInput extends Struct({
  walletPublicKey: PublicKey,
  dayTimestamp:    Field,
  serverPublicKey: PublicKey,
}) {}

const MinalianVerification = ZkProgram({
  name: 'MinalianVerification',
  publicInput: VerificationPublicInput,
  methods: {
    verify: {
      privateInputs: [Signature],
      async method(publicInput, serverAttestation) {
        const msg = [
          publicInput.walletPublicKey.x,
          publicInput.walletPublicKey.toGroup().y,
          publicInput.dayTimestamp,
        ];
        serverAttestation.verify(publicInput.serverPublicKey, msg).assertTrue();
      }
    }
  }
});

// Compile ONCE at startup — never compile again.
// After compile, cache the verification key so /prove and the IPFS upload can
// expose it to end-users for trustless verification.
let compiled = false;
let compilePromise = null;
let VK_BASE64 = null;
let VK_HASH   = null;
async function ensureCompiled() {
  if (compiled) return;
  if (compilePromise) return compilePromise;
  console.log('Compiling ZkProgram...');
  compilePromise = MinalianVerification.compile()
    .then(({ verificationKey }) => {
      VK_BASE64 = verificationKey.data;
      VK_HASH   = verificationKey.hash.toString();
      compiled  = true;
      console.log('Compiled. VK hash:', VK_HASH);
      if (VK_HASH !== EXPECTED_VK_HASH) {
        console.error('⚠ VK HASH MISMATCH — circuit has changed!');
        console.error('  Expected:', EXPECTED_VK_HASH);
        console.error('  Got:     ', VK_HASH);
        console.error('  Existing user proofs will no longer verify against this VK.');
        console.error('  If this change is intentional, update EXPECTED_VK_HASH and the');
        console.error('  matching constants in zk-attest edge function and verify.html.');
      }
    });
  return compilePromise;
}
ensureCompiled().catch(err => console.error('Compile error:', err));

// ── Health ──
app.get('/health', (req, res) => {
  res.json({
    ok:           true,
    compiled,
    serverPubKey: SERVER_PUBLIC_KEY,
    zkAppAddress: process.env.ZKAPP_ADDRESS || null,
    vkHash:       VK_HASH,                  // null until compile finishes
    vkMatches:    VK_HASH === EXPECTED_VK_HASH,
  });
});

// ── Prove ──
app.post('/prove', async (req, res) => {
  const { walletAddress, walletSignature, signedMessage, username, dayTimestamp } = req.body;
  if (!walletAddress || !walletSignature || !signedMessage) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  try {
    // Step 1: Verify Auro signature
    const sigObj  = typeof walletSignature === 'string' ? JSON.parse(walletSignature) : walletSignature;
    const auroSig = { field: sigObj.field ?? sigObj.r, scalar: sigObj.scalar ?? sigObj.s };
    if (!minaClient.verifyMessage({ data: signedMessage, publicKey: walletAddress, signature: auroSig })) {
      return res.status(401).json({ error: 'Invalid wallet signature' });
    }
    console.log('Wallet verified:', username || walletAddress.slice(0,12));

    // Step 2: Server attestation
    const ts            = dayTimestamp ?? Math.floor(Date.now() / 86400000);
    const walletPubKey  = PublicKey.fromBase58(walletAddress);
    const serverPrivKey = PrivateKey.fromBase58(SERVER_PRIVATE_KEY);
    const attestMsg     = [walletPubKey.x, walletPubKey.toGroup().y, Field(ts)];
    const serverAttestation = Signature.create(serverPrivKey, attestMsg);

    // Step 3: Generate ZK proof
    await ensureCompiled();
    const publicInput = new VerificationPublicInput({
      walletPublicKey: walletPubKey,
      dayTimestamp:    Field(ts),
      serverPublicKey: PublicKey.fromBase58(SERVER_PUBLIC_KEY),
    });

    console.log('Generating ZK proof for', username || '?');
    const proof = await MinalianVerification.verify(publicInput, serverAttestation);
    console.log('ZK proof generated.');

    const proofJson = typeof proof.toJSON === 'function' ? proof.toJSON() : {
      publicInput: proof.publicInput, publicOutput: proof.publicOutput,
      maxProofsVerified: proof.maxProofsVerified, proof: proof.proof,
    };

    // Respond immediately — include the full VK so the frontend can forward it to
    // zk-attest and end-users get a self-contained proof.json from IPFS that they
    // can verify in one command (no source-compile required).
    res.json({
      ok: true,
      zkProof: proofJson,
      zkPublicInput: { walletAddress, username, dayTimestamp: ts },
      onChainTx: null,
      verificationKey:     VK_BASE64,
      verificationKeyHash: VK_HASH,
    });

    // Upload proof to IPFS via Pinata (fire-and-forget)
    if (process.env.PINATA_JWT) {
      const pinataJWT   = process.env.PINATA_JWT;
      const supabaseUrl = process.env.SUPABASE_URL;
      const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
      const walletAddr  = walletAddress;
      const day         = ts;
      const proofData   = proofJson;
      const proofHash   = createHash('sha256')
        .update(JSON.stringify(proofJson) + EXPECTED_VK_HASH)
        .digest('hex');

      // Capture VK values for the closure so they can't be mutated mid-upload
      const vkBase64Snapshot = VK_BASE64;
      const vkHashSnapshot   = VK_HASH;

      setImmediate(async () => {
        try {
          // Build the proof document. The full base64 verificationKey is included
          // so anyone can run `o1js.verify(proof.zkProof.proof, proof.verificationKey)`
          // without first compiling the circuit. The verificationKeyHash is also kept
          // for verifiers who DO want to compile from source and confirm a match.
          const ipfsDoc = {
            protocol:            'Mina Protocol / o1js MinalianVerification ZkProgram',
            verificationKeyHash: vkHashSnapshot || EXPECTED_VK_HASH,
            verificationKey:     vkBase64Snapshot,
            serverPublicKey:     SERVER_PUBLIC_KEY,
            walletAddress:       walletAddr,
            dayTimestamp:        day,
            proofHash,
            zkProof:             proofData,
            generatedAt:         new Date().toISOString(),
          };

          // Pin to IPFS via Pinata — upload as named JSON file for proper download
          console.log('Uploading proof to Pinata IPFS...');
          const { FormData: NodeFormData, Blob: NodeBlob } = await import('node:buffer').catch(() => ({}));
          const FD = typeof FormData !== 'undefined' ? FormData : NodeFormData;
          const BL = typeof Blob !== 'undefined' ? Blob : NodeBlob;
          const fd = new FD();
          const jsonStr = JSON.stringify(ipfsDoc, null, 2);
          const filename = 'minalia-proof-' + walletAddr.slice(0, 10) + '.json';
          fd.append('file', new BL([jsonStr], { type: 'application/json' }), filename);
          fd.append('pinataMetadata', JSON.stringify({
            name: filename,
            keyvalues: { walletAddress: walletAddr, proofHash, dayTimestamp: String(day) }
          }));
          fd.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));

          const pinRes = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + pinataJWT },
            body: fd,
          });

          const pinText = await pinRes.text();
          console.log('Pinata response status:', pinRes.status, 'body:', pinText.slice(0, 200));
          if (!pinRes.ok) throw new Error('Pinata error ' + pinRes.status + ': ' + pinText);
          const pinData = JSON.parse(pinText);
          const ipfsCid = pinData.IpfsHash;
          console.log('Proof pinned to IPFS:', ipfsCid);
          console.log('View: https://dweb.link/ipfs/' + ipfsCid);

          // Save CID to DB
          if (supabaseUrl && supabaseKey) {
            await fetch(supabaseUrl + '/rest/v1/users?mina_wallet_address=eq.' + walletAddr, {
              method: 'PATCH',
              headers: {
                'Content-Type': 'application/json',
                'apikey': supabaseKey,
                'Authorization': 'Bearer ' + supabaseKey,
              },
              body: JSON.stringify({ zk_ipfs_cid: ipfsCid }),
            });
            console.log('IPFS CID saved to DB:', ipfsCid);
          }
        } catch(e) {
          console.error('IPFS upload failed (non-fatal):', e.message);
        }
      });
    }

    // On-chain recording handled via GitHub Actions workflow (record-onchain.yml)
    // Triggered manually or via webhook after verification

  } catch (err) {
    console.error('Prove error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});



app.listen(PORT, () => console.log('Minalia proving server on port', PORT));
