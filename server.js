import express from 'express';
import cors from 'cors';
import { ZkProgram, PublicKey, Signature, Field, Poseidon, Struct } from 'o1js';

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: ['https://play.minaliens.xyz', 'http://localhost', 'http://127.0.0.1']
}));
app.use(express.json());

// ── ZkProgram ──
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

ensureCompiled().catch(err => console.error('Compile error:', err));

app.get('/health', (req, res) => {
  res.json({ ok: true, compiled, compiling });
});

app.post('/prove', async (req, res) => {
  const { walletAddress, walletSignature, signedMessage, username, dayTimestamp } = req.body;

  if (!walletAddress || !walletSignature || !username) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    await ensureCompiled();

    // walletSignature may arrive as:
    // 1. A JSON string: '{"field":"...","scalar":"..."}'
    // 2. A plain object: {field:"...", scalar:"..."}
    // Signature.fromJSON() needs a plain object {field, scalar}
    let sigObj;
    if (typeof walletSignature === 'string') {
      try {
        sigObj = JSON.parse(walletSignature);
      } catch(e) {
        return res.status(400).json({ error: 'Invalid walletSignature JSON: ' + e.message });
      }
    } else if (typeof walletSignature === 'object' && walletSignature !== null) {
      sigObj = walletSignature;
    } else {
      return res.status(400).json({ error: 'walletSignature must be a JSON string or object' });
    }

    console.log('sigObj keys:', Object.keys(sigObj));

    const ts         = dayTimestamp ?? Math.floor(Date.now() / 86400000);
    const publicKey  = PublicKey.fromBase58(walletAddress);
    const signature  = Signature.fromJSON(sigObj);

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
