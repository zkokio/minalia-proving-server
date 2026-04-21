#!/usr/bin/env node
// On-chain verification recorder
// Usage: node record-onchain.cjs <walletAddress>
// Fetches proof hash from Supabase, records it on Mina mainnet
//
// REQUIRES these env vars (set via GitHub Actions secrets):
//   SUPABASE_URL            - Supabase project URL
//   SUPABASE_SERVICE_KEY    - Supabase service role key (for DB updates)
//   FEE_PAYER_PRIVATE_KEY   - Private key that pays the transaction fee (EK...)
//   FEE_PAYER_ADDRESS       - Public address for the above (B62q...)
//   ZKAPP_ADDRESS           - zkApp account address where MinaliaVerifier lives
//
// Fee payer is a separate regular account from the zkApp itself. This is because
// the zkApp account has `send` permission locked to Proof-only after deployment,
// so it can't pay transaction fees via signature. A regular account signing
// fees is the standard zkApp pattern.

const { execSync, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const walletAddress = process.argv[2];
if (!walletAddress) { console.error('Usage: node record-onchain.cjs <walletAddress>'); process.exit(1); }

// ── Required env vars ──
const SUPABASE_URL          = process.env.SUPABASE_URL;
const SUPABASE_KEY          = process.env.SUPABASE_SERVICE_KEY;
const FEE_PAYER_PRIVATE_KEY = process.env.FEE_PAYER_PRIVATE_KEY;
const FEE_PAYER_ADDRESS     = process.env.FEE_PAYER_ADDRESS;
const ZKAPP_ADDRESS         = process.env.ZKAPP_ADDRESS;

function requireEnv(name, value) {
  if (!value) {
    console.error('FATAL: ' + name + ' env var is not set.');
    console.error('Set it as a GitHub Actions secret and pass it through in');
    console.error('record-onchain.yml env: block.');
    process.exit(1);
  }
}
requireEnv('SUPABASE_URL',          SUPABASE_URL);
requireEnv('SUPABASE_SERVICE_KEY',  SUPABASE_KEY);
requireEnv('FEE_PAYER_PRIVATE_KEY', FEE_PAYER_PRIVATE_KEY);
requireEnv('FEE_PAYER_ADDRESS',     FEE_PAYER_ADDRESS);
requireEnv('ZKAPP_ADDRESS',         ZKAPP_ADDRESS);

async function fetchProofData() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/users?mina_wallet_address=eq.${walletAddress}&select=zk_proof_hash,zk_onchain_tx,zk_verified_at`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  });
  const data = await res.json();
  return data[0];
}

async function saveOnChainTx(txHash) {
  await fetch(`${SUPABASE_URL}/rest/v1/users?mina_wallet_address=eq.${walletAddress}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    body: JSON.stringify({ zk_onchain_tx: txHash })
  });
}

(async () => {
  console.log('Fetching proof data for:', walletAddress);
  const user = await fetchProofData();
  if (!user) { console.error('No verified user found for this wallet'); process.exit(1); }
  if (!user.zk_proof_hash) { console.error('No proof hash found — verify first'); process.exit(1); }
  if (user.zk_onchain_tx) { console.log('Already recorded on-chain:', user.zk_onchain_tx); process.exit(0); }

  console.log('Proof hash:', user.zk_proof_hash);
  console.log('Verified at:', user.zk_verified_at);

  // Write inline TS deploy script
  const tmpDir = path.join(__dirname, 'tmp-record');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);

  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
    name: 'tmp-record', type: 'module',
    dependencies: { o1js: '2.14.0' },
    devDependencies: { '@types/node': '^20.0.0', typescript: '^5.0.0' }
  }));
  fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2021', module: 'NodeNext', moduleResolution: 'NodeNext',
      experimentalDecorators: true, emitDecoratorMetadata: true,
      strict: false, skipLibCheck: true, outDir: 'dist', types: ['node']
    },
    include: ['*.ts']
  }));

  const proofHash = user.zk_proof_hash;
  const dayTimestamp = Math.floor(new Date(user.zk_verified_at).getTime() / 86400000);

  // Keys read from env inside child — NEVER inlined into the generated TS.
  fs.writeFileSync(path.join(tmpDir, 'record.ts'), `
import { SmartContract, state, State, method, Field, PublicKey, Struct, Mina, PrivateKey, fetchAccount } from 'o1js';

class VerificationEvent extends Struct({
  walletX: Field, walletY: Field,
  proofHashLow: Field, proofHashHigh: Field, dayTimestamp: Field,
}) {}

class MinaliaVerifier extends SmartContract {
  @state(Field) totalVerifications = State<Field>();
  @state(Field) lastWalletX        = State<Field>();
  @state(Field) lastProofHashLow   = State<Field>();
  @state(Field) lastProofHashHigh  = State<Field>();
  @state(Field) lastDayTimestamp   = State<Field>();
  events = { verification: VerificationEvent };

  init() {
    super.init();
    this.totalVerifications.set(Field(0));
    this.lastWalletX.set(Field(0));
    this.lastProofHashLow.set(Field(0));
    this.lastProofHashHigh.set(Field(0));
    this.lastDayTimestamp.set(Field(0));
  }

  @method async recordVerification(
    walletPublicKey: PublicKey, proofHashLow: Field, proofHashHigh: Field, dayTimestamp: Field,
  ) {
    const total = this.totalVerifications.getAndRequireEquals();
    this.totalVerifications.set(total.add(Field(1)));
    this.lastWalletX.set(walletPublicKey.x);
    this.lastProofHashLow.set(proofHashLow);
    this.lastProofHashHigh.set(proofHashHigh);
    this.lastDayTimestamp.set(dayTimestamp);
    this.emitEvent('verification', new VerificationEvent({
      walletX: walletPublicKey.x, walletY: walletPublicKey.toGroup().y,
      proofHashLow, proofHashHigh, dayTimestamp,
    }));
  }
}

async function main() {
  const FEE_PAYER_PRIV = process.env.FEE_PAYER_PRIVATE_KEY;
  const FEE_PAYER_ADDR = process.env.FEE_PAYER_ADDRESS;
  const ZKAPP_ADDR     = process.env.ZKAPP_ADDRESS;
  if (!FEE_PAYER_PRIV || !FEE_PAYER_ADDR || !ZKAPP_ADDR) {
    console.error('FATAL: env vars missing in child process.');
    process.exit(1);
  }

  Mina.setActiveInstance(Mina.Network({
    mina:    'https://api.minascan.io/node/mainnet/v1/graphql',
    archive: 'https://api.minascan.io/archive/mainnet/v1/graphql',
    networkId: 'mainnet',
  }));

  const feePayerKey = PrivateKey.fromBase58(FEE_PAYER_PRIV);
  const feePayerPub = feePayerKey.toPublicKey();
  const zkPub       = PublicKey.fromBase58(ZKAPP_ADDR);
  const walletPub   = PublicKey.fromBase58('${walletAddress}');

  // Fee-payer key-pair sanity check
  const derived = feePayerPub.toBase58();
  if (derived !== FEE_PAYER_ADDR) {
    console.error('FATAL: FEE_PAYER_ADDRESS does not match FEE_PAYER_PRIVATE_KEY.');
    console.error('  Configured:', FEE_PAYER_ADDR);
    console.error('  Derived   :', derived);
    process.exit(1);
  }
  console.log('Fee payer key pair verified. Address:', derived);

  // Confirm fee payer exists and has funds
  const { account: fpAccount } = await fetchAccount({ publicKey: feePayerPub });
  if (!fpAccount) { console.error('Fee payer not found on mainnet.'); process.exit(1); }
  const balanceMina = Number(fpAccount.balance.toBigInt()) / 1e9;
  console.log('Fee payer balance:', balanceMina, 'MINA');
  if (balanceMina < 0.05) {
    console.error('FATAL: Fee payer balance too low to cover 0.01 MINA tx fee.');
    process.exit(1);
  }

  // Confirm zkApp exists and has the contract deployed
  const { account: zkAccount } = await fetchAccount({ publicKey: zkPub });
  if (!zkAccount) { console.error('zkApp not found on mainnet.'); process.exit(1); }
  if (!zkAccount.zkapp) {
    console.error('FATAL: Account exists at zkApp address but no contract is deployed there.');
    console.error('Run the deploy-mainnet workflow first.');
    process.exit(1);
  }
  console.log('zkApp contract found at:', zkPub.toBase58());

  // Split 64-char hex proof hash into two Field values (128 bits each)
  const hashBig = BigInt('0x' + '${proofHash}'.padStart(64, '0'));
  const LOW_MASK = (1n << 128n) - 1n;
  const proofHashLow  = Field(hashBig & LOW_MASK);
  const proofHashHigh = Field(hashBig >> 128n);

  console.log('Compiling MinaliaVerifier...');
  await MinaliaVerifier.compile();
  console.log('Compiled. Building transaction...');

  const zkApp = new MinaliaVerifier(zkPub);

  // Fee payer is sender; zkApp method runs as part of the transaction.
  // Only the fee payer needs to sign — the zkApp method is authorised via proof.
  const tx = await Mina.transaction(
    { sender: feePayerPub, fee: 10_000_000, memo: 'Minalia verify' },
    async () => {
      await zkApp.recordVerification(walletPub, proofHashLow, proofHashHigh, Field(${dayTimestamp}));
    }
  );

  console.log('Proving transaction...');
  await tx.prove();
  tx.sign([feePayerKey]);

  console.log('Sending to mainnet...');
  const sent = await tx.send();

  console.log('\\n✅ RECORDED ON-CHAIN!');
  console.log('TX hash:', sent.hash);
  console.log('Minascan: https://minascan.io/mainnet/tx/' + sent.hash);
}

main().catch(e => { console.error('Failed:', e.message); process.exit(1); });
`);

  console.log('Installing deps...');
  execSync('npm install', { cwd: tmpDir, stdio: 'inherit' });
  console.log('Compiling TypeScript...');
  execSync('npx tsc', { cwd: tmpDir, stdio: 'inherit' });
  console.log('Running...');

  // Forward required env vars to child process.
  const output = execFileSync('node', ['dist/record.js'], {
    cwd: tmpDir, encoding: 'utf8',
    env: {
      ...process.env,
      FEE_PAYER_PRIVATE_KEY,
      FEE_PAYER_ADDRESS,
      ZKAPP_ADDRESS,
    }
  });
  console.log(output);

  // Extract tx hash from output
  const match = output.match(/TX hash: (\w+)/);
  if (match) {
    await saveOnChainTx(match[1]);
    console.log('Saved to DB:', match[1]);
  }
})();
