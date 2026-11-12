import { SetMetadata } from "@nestjs/common";
import { IS_PUBLIC } from "./auth.constants";

/** Route accessible sans authentification. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
