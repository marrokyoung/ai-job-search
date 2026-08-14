import { resolve } from "node:path";
import { openDatabase } from "./database.ts";
import { seedSyntheticData } from "./seed.ts";

const filename = process.argv[2];
if (!filename) {
  console.error(
    "Usage: bun run seed:synthetic -- <absolute-or-relative-path-outside-the-repository>",
  );
  process.exitCode = 1;
} else {
  const database = openDatabase({ filename: resolve(filename) });
  try {
    console.log(JSON.stringify(seedSyntheticData(database), null, 2));
  } finally {
    database.close();
  }
}
