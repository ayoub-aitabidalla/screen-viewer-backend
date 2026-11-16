import "dotenv/config";
import * as bcrypt from "bcrypt";
import { DataSource } from "typeorm";
import { Tenant } from "../tenants/tenant.entity";
import { User } from "../users/user.entity";
import { dbOptions } from "./data-source";

/**
 * Crée le client SEED_TENANT (s'il n'existe pas) et son administrateur SEED_USERNAME,
 * ou met à jour le mot de passe de cet utilisateur s'il existe. Usage : npm run seed
 * Pour ajouter un nouveau client : SEED_TENANT="Client B" SEED_USERNAME=adminb SEED_PASSWORD=... npm run seed
 */
async function main() {
  const tenantName = process.env.SEED_TENANT ?? "Client par défaut";
  const username = process.env.SEED_USERNAME ?? "admin";
  const password = process.env.SEED_PASSWORD;
  if (!password) throw new Error("SEED_PASSWORD manquant dans .env");

  const ds = await new DataSource(dbOptions()).initialize();
  const tenants = ds.getRepository(Tenant);
  const users = ds.getRepository(User);

  let tenant = await tenants.findOneBy({ name: tenantName });
  if (!tenant) {
    tenant = await tenants.save(tenants.create({ name: tenantName }));
    console.log(`Client "${tenantName}" créé.`);
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const existing = await users.findOneBy({ username });
  if (existing) {
    if (existing.tenantId !== tenant.id) throw new Error(`"${username}" appartient déjà à un autre client : choisissez un autre nom.`);
    await users.update(existing.id, { passwordHash });
    console.log(`Utilisateur "${username}" mis à jour.`);
  } else {
    await users.insert({ username, passwordHash, role: "admin", tenantId: tenant.id });
    console.log(`Administrateur "${username}" créé pour le client "${tenantName}".`);
  }
  await ds.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
