import { makeSession } from "../../src/auth.ts";

const email = process.argv[2];
if (!email) process.exit(1);
console.log(await makeSession(email));
