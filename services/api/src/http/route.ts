/**
 * Route helper. Each route declares who may call it and the shape of its input once, as zod
 * schemas; the helper authenticates, authorises, validates and hands the handler typed values.
 * The same schemas feed the OpenAPI document.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { Operator, OperatorRole } from "../chain/custody";
import { pool, queryOne } from "../db/pool";
import { forbidden, unauthorised } from "../lib/errors";

/** `public` needs no session, `operator` any signed-in operator, a list only those roles. */
export type Access = "public" | "operator" | readonly OperatorRole[];

export interface RouteContext<TBody, TQuery, TParams, TOperator> {
  body: TBody;
  query: TQuery;
  params: TParams;
  operator: TOperator;
  request: FastifyRequest;
  reply: FastifyReply;
}

interface RouteOptions<TBody, TQuery, TParams, TAccess extends Access> {
  method: "GET" | "POST";
  url: string;
  tag: string;
  summary: string;
  access: TAccess;
  body?: z.ZodType<TBody>;
  query?: z.ZodType<TQuery>;
  params?: z.ZodType<TParams>;
  handler: (
    context: RouteContext<TBody, TQuery, TParams, TAccess extends "public" ? undefined : Operator>,
  ) => Promise<unknown>;
}

function documentation(schema: z.ZodType | undefined): Record<string, unknown> | undefined {
  if (!schema) return undefined;
  try {
    return z.toJSONSchema(schema, { target: "draft-7", io: "input", unrepresentable: "any" });
  } catch {
    return undefined;
  }
}

async function authenticate(request: FastifyRequest): Promise<Operator> {
  let username: string;
  try {
    ({ sub: username } = await request.jwtVerify<{ sub: string }>());
  } catch {
    throw unauthorised();
  }
  const operator = await queryOne<Operator>(
    pool,
    `SELECT username, display_name, role, institution_id, address, key_index
       FROM operators
      WHERE username = $1 AND active`,
    [username],
  );
  if (!operator) throw unauthorised("This operator profile is no longer active");
  return operator;
}

export function route<
  TBody = undefined,
  TQuery = undefined,
  TParams = undefined,
  const TAccess extends Access = Access,
>(app: FastifyInstance, options: RouteOptions<TBody, TQuery, TParams, TAccess>): void {
  const { access } = options;
  const roles = typeof access === "string" ? "" : ` Roles: ${access.join(", ")}.`;

  app.route({
    method: options.method,
    url: options.url,
    schema: {
      tags: [options.tag],
      summary: options.summary,
      description: access === "public" ? "No session required." : `Requires a session.${roles}`,
      security: access === "public" ? [] : [{ bearer: [] }],
      body: documentation(options.body),
      querystring: documentation(options.query),
      params: documentation(options.params),
    },
    handler: async (request, reply) => {
      let operator: Operator | undefined;
      if (access !== "public") {
        operator = await authenticate(request);
        if (access !== "operator" && !access.includes(operator.role)) throw forbidden();
      }
      return options.handler({
        body: (options.body ? options.body.parse(request.body ?? {}) : undefined) as TBody,
        query: (options.query ? options.query.parse(request.query ?? {}) : undefined) as TQuery,
        params: (options.params ? options.params.parse(request.params ?? {}) : undefined) as TParams,
        operator: operator as TAccess extends "public" ? undefined : Operator,
        request,
        reply,
      });
    },
  });
}
