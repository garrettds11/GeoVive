// Turns ../datamodel.yaml (the data model, repo root) into src/datamodel.json for the Lambdas.
// Run by `npm run build`; test/datamodel.test.mjs fails if the two ever differ.
import { readFileSync, writeFileSync } from "node:fs";
import yaml from "js-yaml";
const model = yaml.load(readFileSync(new URL("../../datamodel.yaml", import.meta.url), "utf8"));
writeFileSync(new URL("../src/datamodel.json", import.meta.url), JSON.stringify(model, null, 1) + "\n");
console.log(`datamodel.json written (version ${model.version})`);
