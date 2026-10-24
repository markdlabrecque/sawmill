import { describeBuild, packageRoot, stampBuild } from './build-identity.js';

// Run by `npm run build` after tsc: records which build dist/ now holds.
console.log(`Stamped ${describeBuild(await stampBuild(packageRoot))}.`);
