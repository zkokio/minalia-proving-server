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

// ── ZkProgram for verification proofs ──
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
        const msg = [publicInput.walletPublicKey.x, publicInput.walletPublicKey.toGroup().y, publicInput.dayTimestamp];
        serverAttestation.verify(publicInput.serverPublicKey, msg).assertTrue();
      }
    }
  }
});

let compiled = false;
let compilePromise = null;
async function ensureCompiled() {
  if (compiled) return;
  if (compilePromise) return compilePromise;
  console.log('Compiling ZkProgram...');
  compilePromise = MinalianVerification.compile()
    .then(() => {
      console.log('ZkProgram compiled. Compiling MinaliaVerifier...');
      return import('./MinaliaVerifier.cjs').then(m => m.MinaliaVerifier.compile());
    })
    .then(() => { compiled = true; console.log('Both compiled.'); });
  return compilePromise;
}
ensureCompiled().catch(err => console.error('Compile error:', err));

// ── Health ──
app.get('/health', (req, res) => {
  res.json({ ok: true, compiled, serverPubKey: SERVER_PUBLIC_KEY, zkAppAddress: process.env.ZKAPP_ADDRESS || null });
});

// ── One-time zkApp deploy ──
// Uses ZkProgram (not SmartContract) to avoid @method decorator issues in ESM
app.get('/deploy-zkapp', async (req, res) => {
  if (req.query.secret !== process.env.DEPLOY_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (process.env.ZKAPP_ADDRESS) {
    return res.json({ ok: true, message: 'Already deployed', zkAppAddress: process.env.ZKAPP_ADDRESS });
  }

  try {
    const { Mina, PrivateKey: MPriv, AccountUpdate, Permissions, fetchAccount } = await import('o1js');

    const DEVNET  = 'https://api.minascan.io/node/devnet/v1/graphql';
    const ARCHIVE = 'https://api.minascan.io/archive/devnet/v1/graphql';
    Mina.setActiveInstance(Mina.Network({ mina: DEVNET, archive: ARCHIVE }));

    const deployerKey = MPriv.fromBase58(SERVER_PRIVATE_KEY);
    const deployerPub = deployerKey.toPublicKey();

    console.log('Checking deployer balance...');
    const r = await fetchAccount({ publicKey: deployerPub });
    if (!r.account) throw new Error('Deployer account not found on devnet — faucet may still be processing');
    const balance = Number(r.account.balance.toBigInt()) / 1e9;
    console.log('Balance:', balance, 'MINA');
    if (balance < 1) throw new Error('Insufficient balance: ' + balance + ' MINA (need 1+)');

    // Generate fresh zkApp keypair
    const zkKey = MPriv.random();
    const zkPub = zkKey.toPublicKey();
    console.log('zkApp address:', zkPub.toBase58());

    // Use the already-compiled MinalianVerification ZkProgram's verification key
    // This associates our ZK proof system with the on-chain account
    console.log('Getting verification key from compiled ZkProgram...');
    await ensureCompiled();
    const { verificationKey } = await MinalianVerification.compile();
    console.log('Got vk. Deploying account...');

    // Create the zkApp account by funding it and setting the verification key
    const tx = await Mina.transaction(
      { sender: deployerPub, fee: 100_000_000 },
      async () => {
        AccountUpdate.fundNewAccount(deployerPub);
        const zkUpdate = AccountUpdate.create(zkPub);
        zkUpdate.account.verificationKey.set(verificationKey);
        zkUpdate.account.permissions.set({
          ...Permissions.default(),
        });
        zkUpdate.requireSignature();
      }
    );

    await tx.prove();
    tx.sign([deployerKey, zkKey]);
    console.log('Sending deploy transaction...');
    const sent = await tx.send();

    console.log('✅ Deployed! tx:', sent.hash);
    res.json({
      ok:              true,
      txHash:          sent.hash,
      zkAppAddress:    zkPub.toBase58(),
      zkAppPrivateKey: zkKey.toBase58(),
      explorerUrl:     'https://minascan.io/devnet/tx/' + sent.hash,
      nextSteps:       'Add to Railway vars: ZKAPP_ADDRESS=' + zkPub.toBase58() + ' and MINA_NETWORK=devnet',
    });
  } catch(err) {
    console.error('Deploy error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Prove ──
app.post('/prove', async (req, res) => {
  const { walletAddress, walletSignature, signedMessage, username, dayTimestamp } = req.body;
  if (!walletAddress || !walletSignature || !signedMessage || !username) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  try {
    const sigObj  = typeof walletSignature === 'string' ? JSON.parse(walletSignature) : walletSignature;
    const auroSig = { field: sigObj.field ?? sigObj.r, scalar: sigObj.scalar ?? sigObj.s };
    if (!minaClient.verifyMessage({ data: signedMessage, publicKey: walletAddress, signature: auroSig })) {
      return res.status(401).json({ error: 'Invalid wallet signature' });
    }
    console.log('Wallet verified:', username);

    const ts            = dayTimestamp ?? Math.floor(Date.now() / 86400000);
    const walletPubKey  = PublicKey.fromBase58(walletAddress);
    const serverPrivKey = PrivateKey.fromBase58(SERVER_PRIVATE_KEY);
    const attestMsg     = [walletPubKey.x, walletPubKey.toGroup().y, Field(ts)];
    const serverAttestation = Signature.create(serverPrivKey, attestMsg);

    await ensureCompiled();
    const publicInput = new VerificationPublicInput({
      walletPublicKey: walletPubKey,
      dayTimestamp:    Field(ts),
      serverPublicKey: PublicKey.fromBase58(SERVER_PUBLIC_KEY),
    });

    console.log('Generating ZK proof for', username);
    const proof = await MinalianVerification.verify(publicInput, serverAttestation);
    console.log('ZK proof generated.');

    let proofJson;
    if (proof && typeof proof.toJSON === 'function') {
      proofJson = proof.toJSON();
    } else {
      proofJson = { publicInput: proof.publicInput, publicOutput: proof.publicOutput, maxProofsVerified: proof.maxProofsVerified, proof: proof.proof };
    }

    // Respond immediately with proof — on-chain recording happens in background
    res.json({ ok: true, zkProof: proofJson, zkPublicInput: { walletAddress, username, dayTimestamp: ts }, onChainTx: null });

    // Fire-and-forget on-chain recording (after response is sent)
    if (process.env.ZKAPP_ADDRESS) {
      const proofHash = createHash('sha256')
        .update(JSON.stringify(proofJson) + '9593722557951211419106663534603742997598351560074849689831849095336735130217')
        .digest('hex');
      const zkAppAddress  = process.env.ZKAPP_ADDRESS;
      const minaNetwork   = process.env.MINA_NETWORK || 'devnet';
      const serverKey     = SERVER_PRIVATE_KEY;
      const walletAddr    = walletAddress;
      const day           = ts;

      setImmediate(async () => {
        try {
          const { recordVerificationOnChain } = await import('./MinaliaVerifier.cjs');
          const result = await recordVerificationOnChain({
            walletAddress: walletAddr, proofHash, dayTimestamp: day,
            serverPrivateKey: serverKey,
            zkAppAddress, network: minaNetwork,
          });
          console.log('On-chain tx recorded:', result.txHash);

          // Update DB with tx hash via Supabase REST
          const SUPABASE_URL = process.env.SUPABASE_URL;
          const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
          if (SUPABASE_URL && SUPABASE_KEY) {
            await fetch(SUPABASE_URL + '/rest/v1/users?mina_wallet_address=eq.' + walletAddr, {
              method: 'PATCH',
              headers: {
                'Content-Type': 'application/json',
                'apikey': SUPABASE_KEY,
                'Authorization': 'Bearer ' + SUPABASE_KEY,
              },
              body: JSON.stringify({ zk_onchain_tx: result.txHash }),
            });
            console.log('DB updated with tx hash.');
          }
        } catch(e) {
          console.error('Background on-chain recording failed:', e.message);
        }
      });
    }
  } catch (err) {
    console.error('Prove error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log('Minalia proving server on port', PORT));
