import { readFile, open, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
const digest = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
async function save(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = await open(temporary, 'wx', 0o600);
  try { await fd.writeFile(JSON.stringify(value, null, 2)); await fd.sync(); } finally { await fd.close(); }
  await rename(temporary, file);
}
/** A submitted ZIP is immutable. Persist its ID before any blocking wait so
 * an interrupted build resumes the same Apple submission, not a new upload. */
export async function notarizeElectron({ archive, receiptFile, binding, profile, keychain, createArchive, run }) {
  let receipt;
  try { receipt = JSON.parse(await readFile(receiptFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (receipt) {
    if (receipt.format !== 1 || !uuid.test(receipt.id) || JSON.stringify(receipt.binding) !== JSON.stringify(binding)
      || receipt.archiveSha256 !== await digest(archive)) throw new Error('Notarization receipt does not match this signed App and ZIP');
  } else {
    await createArchive();
    const archiveSha256 = await digest(archive);
    const submitted = JSON.parse(await run(['submit', archive, '--keychain-profile', profile,
      ...(keychain ? ['--keychain', keychain] : []), '--output-format', 'json']));
    if (!uuid.test(submitted.id)) throw new Error('Apple returned no notarization submission ID');
    receipt = { format: 1, id: submitted.id, binding, archiveSha256, status: 'Submitted', submittedAt: new Date().toISOString() };
    await save(receiptFile, receipt);
  }
  if (['Invalid', 'Rejected'].includes(receipt.status)) throw new Error(`Apple rejected notarization ${receipt.id}. Keep this receipt; fix the App and build into a new output directory.`);
  if (receipt.status !== 'Accepted') {
    const result = JSON.parse(await run(['wait', receipt.id, '--keychain-profile', profile,
      ...(keychain ? ['--keychain', keychain] : []), '--output-format', 'json']));
    if (result.id !== receipt.id || !['Accepted', 'Invalid', 'Rejected', 'In Progress'].includes(result.status)) throw new Error('Invalid notarization status response');
    receipt = { ...receipt, status: result.status, checkedAt: new Date().toISOString() };
    await save(receiptFile, receipt);
    if (result.status !== 'Accepted') throw new Error(`Apple notarization is ${result.status}; submission ${receipt.id}`);
  }
  return receipt;
}
