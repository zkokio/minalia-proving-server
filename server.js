import express from 'express';
import cors from 'cors';
import { ZkProgram, PublicKey, PrivateKey, Signature, Field, Struct } from 'o1js';
import Client from 'mina-signer';
import { createHash } from 'crypto';

const app  = express();
const PORT = process.env.PORT || 3000;

const SERVER_PRIVATE_KEY = process.env.SERVER_PRIVATE_KEY || 'EKDxrPaymujx8HjZJ5iWLLQ4nCyyGa5HieoTEwdcX6T1GvPJgvv4';
const SERVER_PUBLIC_KEY  = 'B62qoq6kq5R4RocoQspdNt948wZEpMWy16EC1HzdWhhuiVpQ8CKxmEr';

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

// Compile ONCE at startup — never compile again
let compiled = false;
let compilePromise = null;
async function ensureCompiled() {
  if (compiled) return;
  if (compilePromise) return compilePromise;
  console.log('Compiling ZkProgram...');
  compilePromise = MinalianVerification.compile()
    .then(() => { compiled = true; console.log('Compiled.'); });
  return compilePromise;
}
ensureCompiled().catch(err => console.error('Compile error:', err));

// ── Health ──
app.get('/health', (req, res) => {
  res.json({ ok: true, compiled, serverPubKey: SERVER_PUBLIC_KEY, zkAppAddress: process.env.ZKAPP_ADDRESS || null });
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

    // Respond immediately
    res.json({ ok: true, zkProof: proofJson, zkPublicInput: { walletAddress, username, dayTimestamp: ts }, onChainTx: null });

    // Upload proof to IPFS via Pinata (fire-and-forget)
    if (process.env.PINATA_JWT) {
      const pinataJWT   = process.env.PINATA_JWT;
      const supabaseUrl = process.env.SUPABASE_URL;
      const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
      const walletAddr  = walletAddress;
      const day         = ts;
      const proofData   = proofJson;
      const proofHash   = createHash('sha256')
        .update(JSON.stringify(proofJson) + '9593722557951211419106663534603742997598351560074849689831849095336735130217')
        .digest('hex');

      setImmediate(async () => {
        try {
          // Build the proof document
          const ipfsDoc = {
            protocol:            'Mina Protocol / o1js MinalianVerification ZkProgram',
            verificationKeyHash: '9593722557951211419106663534603742997598351560074849689831849095336735130217',
            serverPublicKey:     SERVER_PUBLIC_KEY,
            walletAddress:       walletAddr,
            dayTimestamp:        day,
            proofHash,
            zkProof:             proofData,
            generatedAt:         new Date().toISOString(),
          };

          // Pin to IPFS via Pinata
          const formData = new FormData();
          const blob = new Blob([JSON.stringify(ipfsDoc, null, 2)], { type: 'application/json' });
          formData.append('file', blob, 'minalia-proof-' + proofHash.slice(0, 16) + '.json');
          formData.append('pinataMetadata', JSON.stringify({
            name: 'Minalia ZK Proof — ' + walletAddr.slice(0, 16) + '…',
            keyvalues: { walletAddress: walletAddr, proofHash, dayTimestamp: String(day) }
          }));
          formData.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));

          console.log('Uploading proof to Pinata IPFS...');
          const pinRes = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + pinataJWT },
            body: formData,
          });

          const pinText = await pinRes.text();
          console.log('Pinata response status:', pinRes.status, 'body:', pinText.slice(0, 200));
          if (!pinRes.ok) throw new Error('Pinata error ' + pinRes.status + ': ' + pinText);
          const pinData = await pinRes.json();
          const ipfsCid = pinData.IpfsHash;
          console.log('Proof pinned to IPFS:', ipfsCid);
          console.log('View: https://gateway.pinata.cloud/ipfs/' + ipfsCid);

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

    if (false) {
      const proofHash = createHash('sha256')
        .update(JSON.stringify(proofJson) + '9593722557951211419106663534603742997598351560074849689831849095336735130217')
        .digest('hex');
      setImmediate(async () => {
        try {
          const { recordVerificationOnChain } = await import('./MinaliaVerifier.cjs');
          const result = await recordVerificationOnChain({
            walletAddress, proofHash, dayTimestamp: ts,
            serverPrivateKey: SERVER_PRIVATE_KEY,
            zkAppAddress: process.env.ZKAPP_ADDRESS,
            network: process.env.MINA_NETWORK || 'devnet',
          });
          console.log('On-chain tx:', result.txHash);
          // Update DB
          const url = process.env.SUPABASE_URL;
          const key = process.env.SUPABASE_SERVICE_KEY;
          if (url && key) {
            await fetch(url + '/rest/v1/users?mina_wallet_address=eq.' + walletAddress, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json', 'apikey': key, 'Authorization': 'Bearer ' + key },
              body: JSON.stringify({ zk_onchain_tx: result.txHash }),
            });
          }
        } catch(e) { console.error('On-chain failed (non-fatal):', e.message); }
      });
    }

  } catch (err) {
    console.error('Prove error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log('Minalia proving server on port', PORT));
