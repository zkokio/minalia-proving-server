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

app.use(cors({ origin: ['https://play.minaliens.xyz', 'http://localhost', 'http://127.0.0.1'] }));
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
  compilePromise = MinalianVerification.compile().then(() => { compiled = true; console.log('Compiled.'); });
  return compilePromise;
}

ensureCompiled().catch(err => console.error('Compile error:', err));

// ── Health ──
app.get('/health', (req, res) => {
  res.json({ ok: true, compiled, serverPubKey: SERVER_PUBLIC_KEY, zkAppAddress: process.env.ZKAPP_ADDRESS || null });
});

// ── One-time zkApp deploy — GET /deploy-zkapp?secret=XXX ──
app.get('/deploy-zkapp', async (req, res) => {
  if (req.query.secret !== process.env.DEPLOY_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (process.env.ZKAPP_ADDRESS) {
    return res.json({ ok: true, message: 'Already deployed', zkAppAddress: process.env.ZKAPP_ADDRESS });
  }

  try {
    const o1js = await import('o1js');
    const { Mina, PrivateKey, AccountUpdate, fetchAccount, SmartContract, state, State, Field, Struct, method, PublicKey } = o1js;

    const DEVNET  = 'https://api.minascan.io/node/devnet/v1/graphql';
    const ARCHIVE = 'https://api.minascan.io/archive/devnet/v1/graphql';
    Mina.setActiveInstance(Mina.Network({ mina: DEVNET, archive: ARCHIVE }));

    const deployerKey = PrivateKey.fromBase58(SERVER_PRIVATE_KEY);
    const deployerPub = deployerKey.toPublicKey();

    console.log('Fetching deployer account...');
    const r = await fetchAccount({ publicKey: deployerPub });
    if (!r.account) throw new Error('Deployer account not found on devnet — check faucet');

    const balance = Number(r.account.balance.toBigInt()) / 1e9;
    console.log('Balance:', balance, 'MINA');
    if (balance < 1) throw new Error('Need at least 1 MINA, have ' + balance);

    // Minimal zkApp — just state storage, no methods needed for deploy
    class MinaliaVerifierApp extends SmartContract {
      init() {
        super.init();
        this.totalVerifications.set(Field(0));
        this.lastWalletX.set(Field(0));
        this.lastProofHashLow.set(Field(0));
        this.lastProofHashHigh.set(Field(0));
        this.lastDayTimestamp.set(Field(0));
      }
    }

    // Apply state decorators programmatically
    const stateD = state(Field);
    for (const k of ['totalVerifications','lastWalletX','lastProofHashLow','lastProofHashHigh','lastDayTimestamp']) {
      Object.defineProperty(MinaliaVerifierApp.prototype, k, {
        value: new State(), writable: true, configurable: true, enumerable: true
      });
      stateD(MinaliaVerifierApp.prototype, k);
    }

    const zkKey = PrivateKey.random();
    const zkPub = zkKey.toPublicKey();
    console.log('zkApp address will be:', zkPub.toBase58());

    console.log('Compiling zkApp...');
    await MinaliaVerifierApp.compile();
    console.log('Compiled. Deploying...');

    const zkApp = new MinaliaVerifierApp(zkPub);
    const tx = await Mina.transaction({ sender: deployerPub, fee: 100_000_000 }, async () => {
      AccountUpdate.fundNewAccount(deployerPub);
      await zkApp.deploy();
    });
    await tx.prove();
    tx.sign([deployerKey, zkKey]);
    const sent = await tx.send();

    console.log('Deployed! tx:', sent.hash);
    res.json({
      ok: true,
      txHash:          sent.hash,
      zkAppAddress:    zkPub.toBase58(),
      zkAppPrivateKey: zkKey.toBase58(),
      explorerUrl:     'https://minascan.io/devnet/tx/' + sent.hash,
      nextSteps:       'Add ZKAPP_ADDRESS=' + zkPub.toBase58() + ' and MINA_NETWORK=devnet to Railway env vars',
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
    const sigObj = typeof walletSignature === 'string' ? JSON.parse(walletSignature) : walletSignature;
    const auroSig = { field: sigObj.field ?? sigObj.r, scalar: sigObj.scalar ?? sigObj.s };
    const sigValid = minaClient.verifyMessage({ data: signedMessage, publicKey: walletAddress, signature: auroSig });
    if (!sigValid) return res.status(401).json({ error: 'Invalid wallet signature' });

    console.log(`Wallet verified: ${username}`);
    const ts           = dayTimestamp ?? Math.floor(Date.now() / 86400000);
    const walletPubKey = PublicKey.fromBase58(walletAddress);
    const serverPrivKey= PrivateKey.fromBase58(SERVER_PRIVATE_KEY);
    const attestMsg    = [walletPubKey.x, walletPubKey.toGroup().y, Field(ts)];
    const serverAttestation = Signature.create(serverPrivKey, attestMsg);

    await ensureCompiled();

    const publicInput = new VerificationPublicInput({
      walletPublicKey: walletPubKey,
      dayTimestamp:    Field(ts),
      serverPublicKey: PublicKey.fromBase58(SERVER_PUBLIC_KEY),
    });

    console.log(`Generating ZK proof for ${username}...`);
    const proof = await MinalianVerification.verify(publicInput, serverAttestation);
    console.log('ZK proof generated.');

    let proofJson;
    if (proof && typeof proof.toJSON === 'function') {
      proofJson = proof.toJSON();
    } else {
      proofJson = { publicInput: proof.publicInput, publicOutput: proof.publicOutput, maxProofsVerified: proof.maxProofsVerified, proof: proof.proof };
    }

    // Record on-chain if configured
    let onChainTx = null;
    const ZKAPP_ADDRESS = process.env.ZKAPP_ADDRESS;
    const MINA_NETWORK  = process.env.MINA_NETWORK || 'devnet';
    if (ZKAPP_ADDRESS) {
      try {
        const { recordVerificationOnChain } = await import('./record.js');
        const proofHash = createHash('sha256')
          .update(JSON.stringify(proofJson) + '9593722557951211419106663534603742997598351560074849689831849095336735130217')
          .digest('hex');
        onChainTx = await recordVerificationOnChain({ walletAddress, proofHash, dayTimestamp: ts, serverPrivateKey: SERVER_PRIVATE_KEY, zkAppAddress: ZKAPP_ADDRESS, network: MINA_NETWORK });
        console.log('On-chain tx:', onChainTx.txHash);
      } catch(e) { console.error('On-chain failed (non-fatal):', e.message); }
    }

    res.json({ ok: true, zkProof: proofJson, zkPublicInput: { walletAddress, username, dayTimestamp: ts }, onChainTx });

  } catch (err) {
    console.error('Prove error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Minalia proving server on port ${PORT}`));
