import "dotenv/config";
import * as bcrypt from "bcrypt";
import { DataSource } from "typeorm";
import { User } from "../users/user.entity";
import { dbOptions } from "./data-source";

/** Crée l'utilisateur SEED_USERNAME, ou met à jour son mot de passe s'il existe. Usage : npm run seed */
async function main() {
  const username = process.env.SEED_USERNAME ?? "admin";
  const password = process.env.SEED_PASSWORD;
  if (!password) throw new Error("SEED_PASSWORD manquant dans .env");

  const ds = await new DataSource(dbOptions()).initialize();
  const repo = ds.getRepository(User);
  const passwordHash = await bcrypt.hash(password, 12);
  const existing = await repo.findOneBy({ username });
  if (existing) {
    await repo.update(existing.id, { passwordHash });
    console.log(`Utilisateur "${username}" mis à jour.`);
  } else {
    await repo.insert({ username, passwordHash });
    console.log(`Utilisateur "${username}" créé.`);
  }
  await ds.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
