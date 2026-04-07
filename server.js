import express from 'express';
import cors from 'cors';
import { ZkProgram, PublicKey, Signature, Field, Poseidon, Struct, Encoding } from 'o1js';

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: ['https://play.minaliens.xyz', 'http://localhost', 'http://127.0.0.1']
}));
app.use(express.json());

// ── ZkProgram — prove valid Mina wallet signature over a dated message ──
class VerificationPublicInput extends Struct({
  walletPublicKey: PublicKey,
  dayTimestamp:    Field,
}) {}

const MinalianVerification = ZkProgram({
  name: 'MinalianVerification',
  publicInput: VerificationPublicInput,
  methods: {
    verify: {
      privateInputs: [Signature, Field, Field],
      async method(publicInput, walletSignature, msgField0, msgField1) {
        // Prove: I know a valid signature over these message fields
        walletSignature.verify(publicInput.walletPublicKey, [msgField0, msgField1]).assertTrue();
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

  if (!walletAddress || !walletSignature || !signedMessage || !username) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    await ensureCompiled();

    // Parse signature — Auro returns {field, scalar}, o1js needs {r, s}
    const parsed = typeof walletSignature === 'string'
      ? JSON.parse(walletSignature)
      : walletSignature;

    const sigObj = {
      r: parsed.field  ?? parsed.r,
      s: parsed.scalar ?? parsed.s,
    };

    const ts        = dayTimestamp ?? Math.floor(Date.now() / 86400000);
    const publicKey = PublicKey.fromBase58(walletAddress);
    const signature = Signature.fromJSON(sigObj);

    // Convert the signed message string to fields — same as Auro does internally
    const msgFields = Encoding.stringToFields(signedMessage);
    console.log(`Message: "${signedMessage}"`);
    console.log(`msgFields count: ${msgFields.length}`);

    if (msgFields.length < 2) {
      return res.status(400).json({ error: `Need at least 2 message fields, got ${msgFields.length}` });
    }

    const publicInput = new VerificationPublicInput({
      walletPublicKey: publicKey,
      dayTimestamp:    Field(ts),
    });

    console.log(`Generating proof for ${username} (${walletAddress.slice(0,16)}...)...`);
    const proof = await MinalianVerification.verify(
      publicInput, signature, msgFields[0], msgFields[1]
    );
    console.log('Proof generated successfully.');

    res.json({
      ok: true,
      zkProof: proof.toJSON(),
      zkPublicInput: { walletAddress, username, dayTimestamp: ts }
    });

  } catch (err) {
    console.error('Prove error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Minalia proving server running on port ${PORT}`);
});
