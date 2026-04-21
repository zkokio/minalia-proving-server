#!/usr/bin/env node
// On-chain verification recorder
// Usage: node record-onchain.cjs <walletAddress>
// Fetches proof hash from Supabase, records it on Mina mainnet
//
// REQUIRES these env vars (set via GitHub Actions secrets):
//   SUPABASE_URL          - Supabase project URL
//   SUPABASE_SERVICE_KEY  - Supabase service role key (for DB updates)
//   ZKAPP_PRIVATE_KEY     - zkApp fee-payer private key (EK... format)
//   ZKAPP_ADDRESS         - zkApp account address (B62q... format)
//
// Refuses to start if any required env var is missing, and refuses to run if
// ZKAPP_PRIVATE_KEY and ZKAPP_ADDRESS don't form a matching pair. This prevents
// the "one secret updated, the other forgotten" failure mode.

const { execSync, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const walletAddress = process.argv[2];
if (!walletAddress) { console.error('Usage: node record-onchain.cjs <walletAddress>'); process.exit(1); }

// ── Required env vars ──
const SUPABASE_URL       = process.env.SUPABASE_URL;
const SUPABASE_KEY       = process.env.SUPABASE_SERVICE_KEY;
const ZKAPP_PRIVATE_KEY  = process.env.ZKAPP_PRIVATE_KEY;
const ZKAPP_ADDRESS      = process.env.ZKAPP_ADDRESS;

function requireEnv(name, value) {
  if (!value) {
    console.error('FATAL: ' + name + ' env var is not set.');
    console.error('Set it in the repository GitHub Actions secrets and ensure');
    console.error('record-onchain.yml passes it through in the env: block.');
    process.exit(1);
  }
}
requireEnv('SUPABASE_URL',         SUPABASE_URL);
requireEnv('SUPABASE_SERVICE_KEY', SUPABASE_KEY);
requireEnv('ZKAPP_PRIVATE_KEY',    ZKAPP_PRIVATE_KEY);
requireEnv('ZKAPP_ADDRESS',        ZKAPP_ADDRESS);

// Sanity check: confirm the zkApp private key actually produces the configured
// zkApp address. Defers the actual derivation to a small child process because
// o1js is a heavy dep and this file runs before the tmpDir install.
//
// We do this via the generated TS below. If the keys mismatch, Mina.transaction
// will fail with a clear error when signing. So we rely on that failure mode
// rather than loading o1js twice here.

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

  // NOTE: ZKAPP_PRIVATE_KEY and ZKAPP_ADDRESS are read from env inside the
  // generated TS rather than inlined, so the compiled JS file never contains
  // the private key. If this script leaves its tmp-record directory behind
  // (e.g. on failure), the private key is NOT in any file on disk.
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
  // Read from env — NEVER from hardcoded strings.
  const ZKAPP_PRIV = process.env.ZKAPP_PRIVATE_KEY;
  const ZKAPP_ADDR = process.env.ZKAPP_ADDRESS;
  if (!ZKAPP_PRIV || !ZKAPP_ADDR) {
    console.error('FATAL: ZKAPP_PRIVATE_KEY or ZKAPP_ADDRESS missing in child process env.');
    process.exit(1);
  }

  Mina.setActiveInstance(Mina.Network({
    mina:    'https://api.minascan.io/node/mainnet/v1/graphql',
    archive: 'https://api.minascan.io/archive/mainnet/v1/graphql',
    networkId: 'mainnet',
  }));

  const feePayerKey = PrivateKey.fromBase58(ZKAPP_PRIV);
  const feePayerPub = feePayerKey.toPublicKey();
  const zkPub       = PublicKey.fromBase58(ZKAPP_ADDR);
  const walletPub   = PublicKey.fromBase58('${walletAddress}');

  // Key-pair sanity check: derived address must match configured address.
  const derived = feePayerPub.toBase58();
  if (derived !== ZKAPP_ADDR) {
    console.error('FATAL: ZKAPP_ADDRESS does not match ZKAPP_PRIVATE_KEY.');
    console.error('  Configured:', ZKAPP_ADDR);
    console.error('  Derived   :', derived);
    console.error('Update the mismatched secret in GitHub Actions and retry.');
    process.exit(1);
  }
  console.log('zkApp key pair verified. Fee payer:', derived);

  const { account } = await fetchAccount({ publicKey: feePayerPub });
  console.log('Balance:', account ? Number(account.balance.toBigInt()) / 1e9 + ' MINA' : 'NOT FOUND');
  if (!account) { console.error('Fee payer not found on mainnet'); process.exit(1); }

  await fetchAccount({ publicKey: zkPub });

  const hashBig = BigInt('0x' + '${proofHash}'.padStart(64, '0'));
  const LOW_MASK = (1n << 128n) - 1n;
  const proofHashLow  = Field(hashBig & LOW_MASK);
  const proofHashHigh = Field(hashBig >> 128n);

  console.log('Compiling MinaliaVerifier...');
  await MinaliaVerifier.compile();
  console.log('Compiled. Recording...');

  const zkApp = new MinaliaVerifier(zkPub);
  const tx = await Mina.transaction({ sender: feePayerPub, fee: 10_000_000, memo: 'Minalia verify' }, async () => {
    await zkApp.recordVerification(walletPub, proofHashLow, proofHashHigh, Field(${dayTimestamp}));
  });
  await tx.prove();
  tx.sign([feePayerKey]);
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

  // Capture output to get tx hash. Explicitly forward ZKAPP_* env vars so the
  // child process can read them. process.env already includes them but being
  // explicit here documents the contract.
  const output = execFileSync('node', ['dist/record.js'], {
    cwd: tmpDir, encoding: 'utf8',
    env: {
      ...process.env,
      ZKAPP_PRIVATE_KEY,
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
