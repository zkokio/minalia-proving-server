#!/usr/bin/env node
// On-chain verification recorder
// Usage: node record-onchain.cjs <walletAddress>
// Fetches proof hash from Supabase, records it on Mina mainnet

const { execSync, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const walletAddress = process.argv[2];
if (!walletAddress) { console.error('Usage: node record-onchain.cjs <walletAddress>'); process.exit(1); }

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://vvlgaisfhhjvchequmhh.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ZKAPP_PRIVATE_KEY  = 'EKEbTpyViqHqqhL5CBwEfbuk2xgtakja8vciLY33juYAvGEPjCUS';
const ZKAPP_ADDRESS      = 'B62qrmr7hZjMkAdfcSXr1A1bYTn1vQEvGFVYe5yKitPmtWE5RNjHEtf';

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
    dependencies: { o1js: '^2.1.0' },
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
  Mina.setActiveInstance(Mina.Network({
    mina:    'https://api.minascan.io/node/mainnet/v1/graphql',
    archive: 'https://api.minascan.io/archive/mainnet/v1/graphql',
    networkId: 'mainnet',
  }));

  const feePayerKey = PrivateKey.fromBase58('${ZKAPP_PRIVATE_KEY}');
  const feePayerPub = feePayerKey.toPublicKey();
  const zkPub       = PublicKey.fromBase58('${ZKAPP_ADDRESS}');
  const walletPub   = PublicKey.fromBase58('${walletAddress}');

  console.log('Fee payer:', feePayerPub.toBase58());
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

  // Capture output to get tx hash
  const output = execFileSync('node', ['dist/record.js'], {
    cwd: tmpDir, encoding: 'utf8',
    env: { ...process.env }
  });
  console.log(output);

  // Extract tx hash from output
  const match = output.match(/TX hash: (\w+)/);
  if (match) {
    await saveOnChainTx(match[1]);
    console.log('Saved to DB:', match[1]);
  }
})();
