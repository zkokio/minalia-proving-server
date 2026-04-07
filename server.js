import express from 'express';
import cors from 'cors';
import { ZkProgram, PublicKey, PrivateKey, Signature, Field, Struct } from 'o1js';
import Client from 'o1js/dist/web/mina-signer/mina-signer.js';

const app  = express();
const PORT = process.env.PORT || 3000;

// Minalia server signing key — attests verified wallet ownership
// Public key is hardcoded in the ZkProgram circuit
const SERVER_PRIVATE_KEY = process.env.SERVER_PRIVATE_KEY || 'EKDxrPaymujx8HjZJ5iWLLQ4nCyyGa5HieoTEwdcX6T1GvPJgvv4';
const SERVER_PUBLIC_KEY  = 'B62qoq6kq5R4RocoQspdNt948wZEpMWy16EC1HzdWhhuiVpQ8CKxmEr';

const minaClient = new Client({ network: 'mainnet' });

app.use(cors({
  origin: ['https://play.minaliens.xyz', 'http://localhost', 'http://127.0.0.1']
}));
app.use(express.json());

// ── ZkProgram — must match prove.ts exactly ──
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

let compiled = false;
let compilePromise = null;

async function ensureCompiled() {
  if (compiled) return;
  if (compilePromise) return compilePromise;
  console.log('Compiling ZkProgram...');
  compilePromise = MinalianVerification.compile().then(() => {
    compiled = true;
    console.log('Compiled.');
  });
  return compilePromise;
}

ensureCompiled().catch(err => console.error('Compile error:', err));

app.get('/health', (req, res) => {
  res.json({ ok: true, compiled, serverPubKey: SERVER_PUBLIC_KEY });
});

app.post('/prove', async (req, res) => {
  const { walletAddress, walletSignature, signedMessage, username, dayTimestamp } = req.body;

  if (!walletAddress || !walletSignature || !signedMessage || !username) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    // Step 1: Verify the Auro wallet signature using mina-signer (pure JS)
    const sigObj = typeof walletSignature === 'string'
      ? JSON.parse(walletSignature)
      : walletSignature;

    // mina-signer needs {field, scalar} format
    const auroSig = {
      field:  sigObj.field  ?? sigObj.r,
      scalar: sigObj.scalar ?? sigObj.s,
    };

    const sigValid = minaClient.verifyMessage({
      data:      signedMessage,
      publicKey: walletAddress,
      signature: auroSig,
    });

    if (!sigValid) {
      return res.status(401).json({ error: 'Invalid wallet signature — ownership proof failed' });
    }

    console.log(`Wallet ownership verified for ${username} (${walletAddress.slice(0,16)}...)`);

    // Step 2: Server creates an o1js attestation signature
    const ts           = dayTimestamp ?? Math.floor(Date.now() / 86400000);
    const walletPubKey = PublicKey.fromBase58(walletAddress);
    const serverPrivKey= PrivateKey.fromBase58(SERVER_PRIVATE_KEY);

    const attestMsg = [
      walletPubKey.x,
      walletPubKey.toGroup().y,
      Field(ts),
    ];

    const serverAttestation = Signature.create(serverPrivKey, attestMsg);
    console.log('Server attestation created.');

    // Step 3: Generate ZK proof
    await ensureCompiled();

    const serverPubKey = PublicKey.fromBase58(SERVER_PUBLIC_KEY);
    const publicInput  = new VerificationPublicInput({
      walletPublicKey: walletPubKey,
      dayTimestamp:    Field(ts),
      serverPublicKey: serverPubKey,
    });

    console.log(`Generating ZK proof for ${username}...`);
    const proof = await MinalianVerification.verify(publicInput, serverAttestation);
    console.log('ZK proof generated.');

    res.json({
      ok:             true,
      zkProof:        proof.toJSON(),
      zkPublicInput:  { walletAddress, username, dayTimestamp: ts },
    });

  } catch (err) {
    console.error('Prove error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Minalia proving server on port ${PORT}`);
});
