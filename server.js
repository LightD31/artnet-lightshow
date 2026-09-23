// Start the light show server.
//
// The server is TypeScript (src/main.ts), run as it is by Node's built-in type
// stripping, which Node 22.18 turned on by default. There is no build step,
// so a Node without it would fail on the first type annotation with a syntax
// error that says nothing about why; this says it first.
if (!process.features?.typescript) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const recentEnough = major > 22 || (major === 22 && minor >= 18);
  console.error(recentEnough
    ? `artnet-lightshow runs its TypeScript directly, and this Node (${process.version}) has that turned off. `
      + 'Check NODE_OPTIONS and the command line for --no-experimental-strip-types.'
    : `artnet-lightshow needs Node.js 22.18 or newer, which runs TypeScript directly. `
      + `This is Node ${process.version}. Install the current LTS from https://nodejs.org/ and run it again.`);
  process.exit(1);
}

await import('./src/main.ts');
