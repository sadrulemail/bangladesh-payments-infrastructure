import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Operator } from "../chain/custody";
import { config } from "../config";
import { pool, query, queryOne } from "../db/pool";
import { route } from "../http/route";
import { notFound, unauthorised } from "../lib/errors";
import { verifyPassphrase } from "./passwords";

const signIn = z.object({
  username: z.string().trim().min(1).max(64),
  passphrase: z.string().min(1).max(256),
});

const OPERATOR_COLUMNS = "username, display_name, role, institution_id, address, key_index";

export function authRoutes(app: FastifyInstance): void {
  route(app, {
    method: "POST",
    url: "/v1/auth/sign-in",
    tag: "Session",
    summary: "Open a session",
    access: "public",
    body: signIn,
    handler: async ({ body }) => {
      const operator = await queryOne<Operator & { passwordHash: string }>(
        pool,
        `SELECT ${OPERATOR_COLUMNS}, password_hash FROM operators WHERE username = $1 AND active`,
        [body.username],
      );
      // The same answer for an unknown user and a wrong passphrase.
      if (!operator || !verifyPassphrase(body.passphrase, operator.passwordHash)) {
        throw unauthorised("The username or passphrase is not correct");
      }
      const { passwordHash: _passwordHash, ...profile } = operator;
      const token = app.jwt.sign({ sub: profile.username }, { expiresIn: `${config.auth.sessionHours}h` });
      return { token, operator: profile };
    },
  });

  route(app, {
    method: "GET",
    url: "/v1/auth/session",
    tag: "Session",
    summary: "Operator of the current session",
    access: "operator",
    handler: async ({ operator }) => operator,
  });

  route(app, {
    method: "GET",
    url: "/v1/auth/profiles",
    tag: "Session",
    summary: "Operator profiles for the sign-in page (private environments only)",
    access: "public",
    handler: async () => {
      if (!config.auth.operatorDirectory) throw notFound("The operator directory");
      return query(
        pool,
        `SELECT o.username, o.display_name, o.role, o.institution_id, i.name AS institution_name
           FROM operators o
           LEFT JOIN institutions i ON i.id = o.institution_id
          WHERE o.active
          ORDER BY o.key_index`,
      );
    },
  });
}
