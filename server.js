import express from 'express';
import cors from 'cors';
import { ZkProgram, PublicKey, Signature, Field, Poseidon, Struct } from 'o1js';

const app  = express();
const PORT = process.env.PORT || 3000;

// Allow requests from play.minaliens.xyz (and localhost for testing)
app.use(cors({
  origin: [
    'https://play.minaliens.xyz',
    'http://localhost',
    'http://127.0.0.1'
  ]
}));
app.use(express.json());

// ── ZkProgram — must exactly match the client definition ──
class VerificationPublicInput extends Struct({
  walletPublicKey: PublicKey,
  usernameHash:    Field,
  timestampField:  Field,
}) {}

const MinalianVerification = ZkProgram({
  name: 'MinalianVerification',
  publicInput: VerificationPublicInput,
  methods: {
    verify: {
      privateInputs: [Signature, Field],
      async method(publicInput, walletSignature, messageHash) {
        walletSignature.verify(publicInput.walletPublicKey, [messageHash]).assertTrue();
        const expectedHash = Poseidon.hash([publicInput.usernameHash, publicInput.timestampField]);
        messageHash.assertEquals(expectedHash);
      }
    }
  }
});

// Compile once at startup — takes ~60s, then stays compiled
let compiled = false;
let compiling = false;
let compilePromise = null;

async function ensureCompiled() {
  if (compiled) return;
  if (compiling) return compilePromise;
  compiling = true;
  console.log('Compiling MinalianVerification ZkProgram...');
  compilePromise = MinalianVerification.compile().then(() => {
    compiled = true;
    compiling = false;
    console.log('Compiled successfully.');
  });
  return compilePromise;
}

// Start compiling immediately on boot
ensureCompiled().catch(err => console.error('Compile error:', err));

// ── Health check ──
app.get('/health', (req, res) => {
  res.json({ ok: true, compiled, compiling });
});

// ── Prove endpoint ──
app.post('/prove', async (req, res) => {
  const { walletAddress, walletSignature, signedMessage, username, dayTimestamp } = req.body;

  if (!walletAddress || !walletSignature || !username) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    await ensureCompiled();

    const walletSignatureJson = typeof walletSignature === 'string'
      ? walletSignature
      : JSON.stringify(walletSignature);

    const ts         = dayTimestamp ?? Math.floor(Date.now() / 86400000);
    const publicKey  = PublicKey.fromBase58(walletAddress);
    const signature  = Signature.fromJSON(JSON.parse(walletSignatureJson));

    const usernameHash   = Poseidon.hash(
      [...new TextEncoder().encode(username)].map(b => Field(b))
    );
    const timestampField = Field(ts);
    const messageHash    = Poseidon.hash([usernameHash, timestampField]);

    const publicInput = new VerificationPublicInput({
      walletPublicKey: publicKey,
      usernameHash,
      timestampField,
    });

    console.log(`Generating proof for ${username} (${walletAddress.slice(0,16)}...)...`);
    const proof = await MinalianVerification.verify(publicInput, signature, messageHash);
    console.log('Proof generated.');

    res.json({ ok: true, zkProof: proof.toJSON(), zkPublicInput: { walletAddress, username, dayTimestamp: ts } });

  } catch (err) {
    console.error('Prove error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Minalia proving server running on port ${PORT}`);
});
