import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { ZodError } from "zod";

import { authRoutes } from "../auth/routes";
import { config } from "../config";
import { AppError } from "../lib/errors";
import { directoryRoutes } from "../modules/directory";
import { disbursementRoutes } from "../modules/disbursements";
import { ledgerRoutes } from "../modules/ledger";
import { overviewRoutes } from "../modules/overview";
import { paymentRoutes } from "../modules/payments";
import { remittanceRoutes } from "../modules/remittances";
import { reportRoutes } from "../modules/reports";
import { reserveRoutes } from "../modules/reserves";

const toJson = (payload: unknown) =>
  JSON.stringify(payload, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value));

function errorBody(code: string, message: string, details?: unknown) {
  return { error: { code, message, details } };
}

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.environment === "production" ? "info" : "warn" },
    disableRequestLogging: config.environment !== "production",
  });

  // Input is validated by the zod schema of each route; the JSON schemas only document the API.
  app.setValidatorCompiler(() => () => true);
  // Amounts are bigint in the service and decimal strings on the wire.
  app.setReplySerializer(toJson);

  await app.register(cors, { origin: config.http.consoleOrigin });
  await app.register(jwt, { secret: config.auth.jwtSecret });
  await app.register(swagger, {
    openapi: {
      info: {
        title: "TakaRail settlement API",
        version: "1.0.0",
        description:
          "Read models, ledger and channel endpoints of the TakaRail network. Amounts are integers in poisha, " +
          "sent as decimal strings.",
      },
      components: { securitySchemes: { bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" } } },
    },
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  app.setErrorHandler((error: FastifyError | Error, _request, reply) => {
    if (error instanceof ZodError) {
      const details = error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
      return reply.status(400).send(errorBody("VALIDATION", "The request is not valid", details));
    }
    if (error instanceof AppError) {
      return reply.status(error.status).send(errorBody(error.code, error.message, error.details));
    }
    const status = "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 500;
    if (status >= 500) app.log.error(error);
    return reply
      .status(status)
      .send(errorBody(status >= 500 ? "INTERNAL" : "BAD_REQUEST", status >= 500 ? "Unexpected error" : error.message));
  });

  app.get("/health", { schema: { hide: true } }, async () => ({ status: "ok" }));

  authRoutes(app);
  overviewRoutes(app);
  directoryRoutes(app);
  paymentRoutes(app);
  remittanceRoutes(app);
  reserveRoutes(app);
  disbursementRoutes(app);
  ledgerRoutes(app);
  reportRoutes(app);

  return app;
}
