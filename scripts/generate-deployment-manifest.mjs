import { generateDeploymentManifest } from "../dist/tool-surface-deployment-cli.js";

await generateDeploymentManifest(process.argv.slice(2));
