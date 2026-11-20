// Runs from the "prepare" script after `npm install`: turns on the git hooks in .husky/.
// husky is a dev dependency, so a production install (`npm ci --omit=dev`) does not have it.
// That is fine: there is nothing to set up on a server, so we skip quietly instead of failing the install.
try {
  const husky = (await import('husky')).default;
  console.log(husky());
} catch {
  // husky not installed: nothing to do.
}
