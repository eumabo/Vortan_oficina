import { Hono } from "npm:hono";
import { cors } from "npm:hono/cors";
import { createClient } from "jsr:@supabase/supabase-js@2";

const app = new Hono();
const P = "/rapid-action";

if (Deno.env.get("VORTAN_DEBUG_REQUESTS") === "true") {
  app.use("*", async (c, next) => {
    const started = Date.now();
    await next();
    const pathname = new URL(c.req.url).pathname.replace(/\/public\/orders\/[^/]+$/, "/public/orders/[redacted]");
    console.log(`${c.req.method} ${pathname} ${c.res.status} ${Date.now() - started}ms`);
  });
}

app.use(
  "*",
  cors({
    origin: (origin) => {
      const allowedOrigins = [
        "http://localhost:5173",
        "https://autoflowoficina.online",
        "https://www.autoflowoficina.online",
        "https://vortanoficina.com.br",
        "https://www.vortanoficina.com.br",
        "https://autoflow-saas-two.vercel.app",
      ];

      if (allowedOrigins.includes(origin)) return origin;

      if (/^https:\/\/autoflow-saas-[a-z0-9-]+\.vercel\.app$/.test(origin)) {
        return origin;
      }

      return "";
    },
    allowHeaders: ["authorization", "x-client-info", "apikey", "content-type"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  }),
);

app.options("*", (c) => c.text("", 204));

// Security headers: API responses are never meant to be embedded or cached.
app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  c.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  c.header("Cache-Control", "no-store, max-age=0");
  c.header("Pragma", "no-cache");
  if (new URL(c.req.url).protocol === "https:") {
    c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
});

type RateBucket = { count: number; resetAt: number };
const rateBuckets = new Map<string, RateBucket>();

function requesterKey(c: any) {
  const ip =
    c.req.header("cf-connecting-ip") ??
    c.req.header("x-real-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  if (ip) return ip;
  const auth = c.req.header("Authorization") ?? "";
  return auth ? `auth:${auth.slice(-24)}` : `ua:${(c.req.header("user-agent") ?? "unknown").slice(0, 80)}`;
}

function checkRateLimit(c: any) {
  if (c.req.method === "OPTIONS") return null;
  const path = new URL(c.req.url).pathname;
  let limit = 600;
  let scope = "read";

  if (path.includes("/billing/webhook")) {
    limit = 600;
    scope = "webhook";
  } else if (path.includes("/public/orders/")) {
    limit = 120;
    scope = "public-order";
  } else if (path.includes("/billing/")) {
    limit = 30;
    scope = "billing";
  } else if (path.includes("/admin/")) {
    limit = 120;
    scope = "admin";
  } else if (c.req.method !== "GET") {
    limit = 180;
    scope = "mutation";
  }

  const now = Date.now();
  const key = `${scope}:${requesterKey(c)}`;
  const existing = rateBuckets.get(key);
  const bucket = !existing || existing.resetAt <= now
    ? { count: 0, resetAt: now + 60_000 }
    : existing;
  bucket.count += 1;
  rateBuckets.set(key, bucket);

  if (rateBuckets.size > 5000) {
    for (const [bucketKey, value] of rateBuckets) {
      if (value.resetAt <= now) rateBuckets.delete(bucketKey);
    }
  }

  if (bucket.count > limit) {
    c.header("Retry-After", String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
    return c.json({ error: "Muitas requisiÃ§Ãµes. Tente novamente em instantes." }, 429);
  }
  return null;
}

app.use("*", async (c, next) => {
  const limited = checkRateLimit(c);
  if (limited) return limited;
  await next();
});

// â”€â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function svc() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

async function getUser(authHeader: string | undefined) {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const {
    data: { user },
    error,
  } = await svc().auth.getUser(authHeader.slice(7));
  if (error || !user) return null;
  return user;
}

const unauthorized = (c: any) => c.json({ error: "Unauthorized" }, 401);
const badRequest = (c: any, msg: string) => c.json({ error: msg }, 400);
const serverError = (c: any, internal: unknown, publicMessage = "Erro interno do servidor") => {
  console.error("Vortan API error:", internal);
  return c.json({ error: publicMessage }, 500);
};

async function readJsonObject(c: any, maxBytes = 64 * 1024) {
  const declaredLength = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return { body: null, response: c.json({ error: "RequisiÃ§Ã£o muito grande" }, 413) };
  }

  try {
    const body = await c.req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return { body: null, response: badRequest(c, "JSON invÃ¡lido") };
    }
    const size = new TextEncoder().encode(JSON.stringify(body)).byteLength;
    if (size > maxBytes) {
      return { body: null, response: c.json({ error: "RequisiÃ§Ã£o muito grande" }, 413) };
    }
    return { body, response: null };
  } catch {
    return { body: null, response: badRequest(c, "JSON invÃ¡lido") };
  }
}

function textValue(value: unknown, maxLength: number, trim = true): string | null {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value);
  const normalized = trim ? text.trim() : text;
  if (normalized.length > maxLength) return null;
  return normalized;
}

function finiteAmount(value: unknown, max = 1_000_000_000) {
  const amount = typeof value === "number" ? value : Number(String(value ?? "").replace(",", "."));
  if (!Number.isFinite(amount) || amount < 0 || amount > max) return null;
  return amount;
}

function safeDateValue(value: unknown) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || value.length > 40) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : value;
}

async function getSubscription(userId: string) {
  const { data, error } = await svc()
    .from("subscriptions")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

function isSubscriptionActive(sub: any) {
  if (!sub) return false;
  if (sub.status !== "active" && sub.status !== "trial") return false;
  if (!sub.expires_at) return false;
  return new Date(sub.expires_at).getTime() > Date.now();
}

async function requireActiveSubscription(c: any, user: any) {
  const { data: profile, error: profileError } = await svc()
    .from("af_profiles")
    .select("is_admin")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError) {
    return serverError(c, profileError);
  }

  if (profile?.is_admin === true) {
    return null;
  }

  const sub = await getSubscription(user.id);

  if (!isSubscriptionActive(sub)) {
    return c.json(
      {
        error: "Assinatura inativa ou expirada",
        code: "SUBSCRIPTION_REQUIRED",
      },
      402,
    );
  }

  return null;
}

async function requireAdmin(c: any) {
  const user = await getUser(c.req.header("Authorization"));
  if (!user) return { user: null, response: unauthorized(c) };

  const { data: profile, error } = await svc()
    .from("af_profiles")
    .select("is_admin")
    .eq("id", user.id)
    .maybeSingle();

  if (error) {
    return { user: null, response: serverError(c, error) };
  }

  if (profile?.is_admin !== true) {
    return {
      user: null,
      response: c.json({ error: "Acesso administrativo negado" }, 403),
    };
  }

  return { user, response: null };
}

// â”€â”€â”€ Admin â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

app.get(`${P}/admin/workshops`, async (c) => {
  const admin = await requireAdmin(c);
  if (admin.response) return admin.response;

  const [profilesRes, clientsRes, vehiclesRes, ordersRes] = await Promise.all([
    svc()
      .from("af_profiles")
      .select(
        "id, owner_name, workshop_name, phone, whatsapp, city, state, subscription_status, subscription_ends_at, created_at, is_admin",
      )
      .order("created_at", { ascending: false }),
    svc().from("af_clients").select("id, workshop_id"),
    svc().from("af_vehicles").select("id, workshop_id"),
    svc().from("af_service_orders").select("id, workshop_id"),
  ]);

  const firstError =
    profilesRes.error ||
    clientsRes.error ||
    vehiclesRes.error ||
    ordersRes.error;
  if (firstError) return serverError(c, firstError);

  const countByWorkshop = (rows: any[] | null) =>
    (rows ?? []).reduce<Record<string, number>>((acc, row) => {
      if (row.workshop_id) {
        acc[row.workshop_id] = (acc[row.workshop_id] ?? 0) + 1;
      }
      return acc;
    }, {});

  const clientsCount = countByWorkshop(clientsRes.data);
  const vehiclesCount = countByWorkshop(vehiclesRes.data);
  const ordersCount = countByWorkshop(ordersRes.data);

  const profiles = (profilesRes.data ?? []).map((profile: any) => ({
    ...profile,
    total_clients: clientsCount[profile.id] ?? 0,
    total_vehicles: vehiclesCount[profile.id] ?? 0,
    total_orders: ordersCount[profile.id] ?? 0,
  }));

  return c.json(profiles);
});

app.post(`${P}/admin/workshops/:id/subscription`, async (c) => {
  const admin = await requireAdmin(c);
  if (admin.response) return admin.response;

  const targetId = c.req.param("id");
  if (!isUuid(targetId)) return badRequest(c, "Oficina invÃ¡lida");
  const parsed = await readJsonObject(c, 8 * 1024);
  if (parsed.response) return parsed.response;
  const body = parsed.body;
  const action = textValue(body.action, 32) ?? "";

  const { data: targetProfile, error: targetError } = await svc()
    .from("af_profiles")
    .select("id, is_admin")
    .eq("id", targetId)
    .maybeSingle();

  if (targetError) return serverError(c, targetError);
  if (!targetProfile) return c.json({ error: "Oficina nÃ£o encontrada" }, 404);

  const now = new Date();
  let status: "active" | "trial" | "expired";
  let expiresAt: Date;
  let subscriptionPatch: Record<string, unknown> = {};

  if (action === "activate") {
    status = "active";
    expiresAt = addMonths(now, 1);
    subscriptionPatch = {
      provider_status: "manual_admin",
      cancel_at_period_end: false,
      canceled_at: null,
    };
  } else if (action === "renew_trial") {
    status = "trial";
    expiresAt = new Date(now);
    expiresAt.setDate(expiresAt.getDate() + 15);
    subscriptionPatch = {
      provider_status: "manual_admin",
      trial_started_at: now.toISOString(),
      trial_ends_at: expiresAt.toISOString(),
      trial_used: true,
      cancel_at_period_end: false,
      canceled_at: null,
    };
  } else if (action === "block") {
    status = "expired";
    expiresAt = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    subscriptionPatch = {
      provider_status: "blocked_by_admin",
      cancel_at_period_end: false,
    };
  } else {
    return badRequest(c, "AÃ§Ã£o administrativa invÃ¡lida");
  }

  try {
    await syncAccessState({
      userId: targetId,
      status,
      expiresAt,
      subscriptionPatch,
    });
  } catch (error: any) {
    return serverError(c, error?.message ?? "Erro ao atualizar assinatura");
  }

  const { data, error } = await svc()
    .from("af_profiles")
    .select(
      "id, owner_name, workshop_name, phone, whatsapp, city, state, subscription_status, subscription_ends_at, created_at, is_admin",
    )
    .eq("id", targetId)
    .maybeSingle();

  if (error) return serverError(c, error);
  if (!data) return c.json({ error: "Oficina nÃ£o encontrada" }, 404);

  return c.json(data);
});

// â”€â”€â”€ Health â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

app.get(`${P}/health`, (c) =>
  c.json({ status: "ok", ts: new Date().toISOString() }),
);

// â”€â”€â”€ Profile â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

app.get(`${P}/profile`, async (c) => {
  const user = await getUser(c.req.header("Authorization"));
  if (!user) return unauthorized(c);
  const { data, error } = await svc()
    .from("af_profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();
  if (error) return serverError(c, error);
  return c.json(data);
});

app.post(`${P}/profile`, async (c) => {
  const user = await getUser(c.req.header("Authorization"));
  if (!user) return unauthorized(c);

  const parsed = await readJsonObject(c);
  if (parsed.response) return parsed.response;
  const body = parsed.body;

  const workshopName = textValue(body.workshop_name, 160);
  const ownerName = textValue(body.owner_name, 160);
  const phone = textValue(body.phone, 40);
  const whatsapp = textValue(body.whatsapp, 40);
  const instagram = textValue(body.instagram, 120);
  const address = textValue(body.address, 300);
  const city = textValue(body.city, 120);
  const state = textValue(body.state, 40);
  const logoUrl = textValue(body.logo_url, 4096);

  if (!workshopName) return badRequest(c, "Nome da oficina Ã© obrigatÃ³rio");
  if ([ownerName, phone, whatsapp, instagram, address, city, state, logoUrl].some((v) => v === null)) {
    return badRequest(c, "Dados do perfil invÃ¡lidos ou muito longos");
  }

  const { error } = await svc()
    .from("af_profiles")
    .upsert({
      id: user.id,
      workshop_name: workshopName,
      owner_name: ownerName,
      phone,
      whatsapp,
      instagram,
      address,
      city,
      state,
      logo_url: logoUrl,
    });

  if (error) return serverError(c, error);

  try {
    await activateTrialAccess({
      userId: user.id,
      email: user.email,
    });
  } catch (trialError) {
    console.error("Erro ao criar teste grÃ¡tis:", trialError);
    return serverError(c, "Erro ao ativar teste grÃ¡tis");
  }

  const { data: updatedProfile, error: profileError } = await svc()
    .from("af_profiles")
    .select()
    .eq("id", user.id)
    .single();

  if (profileError) return serverError(c, profileError);

  return c.json(updatedProfile);
});

// â”€â”€â”€ Clients â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

app.get(`${P}/clients`, async (c) => {
  const user = await getUser(c.req.header("Authorization"));
  if (!user) return unauthorized(c);

  const blocked = await requireActiveSubscription(c, user);
  if (blocked) return blocked;
  const { data, error } = await svc()
    .from("af_clients")
    .select("*")
    .eq("workshop_id", user.id)
    .order("created_at", { ascending: false });
  if (error) return serverError(c, error);
  return c.json(data ?? []);
});

app.post(`${P}/clients`, async (c) => {
  const user = await getUser(c.req.header("Authorization"));
  if (!user) return unauthorized(c);

  const blocked = await requireActiveSubscription(c, user);
  if (blocked) return blocked;
  const parsed = await readJsonObject(c);
  if (parsed.response) return parsed.response;
  const body = parsed.body;
  const name = textValue(body.name, 160);
  const phone = textValue(body.phone, 40);
  const whatsapp = textValue(body.whatsapp, 40);
  if (!name) return badRequest(c, "Nome Ã© obrigatÃ³rio");
  if (phone === null || whatsapp === null) return badRequest(c, "Contato invÃ¡lido ou muito longo");
  const { data, error } = await svc()
    .from("af_clients")
    .insert({
      workshop_id: user.id,
      name,
      phone,
      whatsapp,
    })
    .select()
    .single();
  if (error) return serverError(c, error);
  return c.json(data, 201);
});

app.put(`${P}/clients/:id`, async (c) => {
  const user = await getUser(c.req.header("Authorization"));
  if (!user) return unauthorized(c);

  const blocked = await requireActiveSubscription(c, user);
  if (blocked) return blocked;
  const id = c.req.param("id");
  if (!isUuid(id)) return badRequest(c, "Cliente invÃ¡lido");
  const parsed = await readJsonObject(c);
  if (parsed.response) return parsed.response;
  const body = parsed.body;
  const name = textValue(body.name, 160);
  const phone = textValue(body.phone, 40);
  const whatsapp = textValue(body.whatsapp, 40);
  if (!name) return badRequest(c, "Nome Ã© obrigatÃ³rio");
  if (phone === null || whatsapp === null) return badRequest(c, "Contato invÃ¡lido ou muito longo");
  const { data, error } = await svc()
    .from("af_clients")
    .update({ name, phone, whatsapp })
    .eq("id", id)
    .eq("workshop_id", user.id)
    .select()
    .single();
  if (error) return serverError(c, error);
  if (!data) return c.json({ error: "Not found" }, 404);
  return c.json(data);
});

// ===== ROTA PÃšBLICA DA OS =====
app.get(`${P}/public/orders/:token`, async (c) => {
  const token = c.req.param("token");
  if (!isUuid(token)) return badRequest(c, "Token invÃ¡lido");

  const { data: order, error } = await svc()
    .from("af_service_orders")
    .select(
      "id, workshop_id, client_id, vehicle_id, status, value, delivery_date, reported_issue, services_performed, notes",
    )
    .eq("public_token", token)
    .maybeSingle();

  if (error) return serverError(c, error);
  if (!order) return c.json({ error: "OS nÃ£o encontrada" }, 404);

  const [{ data: profile }, { data: client }, { data: vehicle }] =
    await Promise.all([
      svc()
        .from("af_profiles")
        .select("workshop_name, logo_url, whatsapp")
        .eq("id", order.workshop_id)
        .maybeSingle(),
      svc()
        .from("af_clients")
        .select("name")
        .eq("id", order.client_id)
        .eq("workshop_id", order.workshop_id)
        .maybeSingle(),
      svc()
        .from("af_vehicles")
        .select("brand, model, plate")
        .eq("id", order.vehicle_id)
        .eq("workshop_id", order.workshop_id)
        .maybeSingle(),
    ]);

  return c.json({
    order: {
      ...order,
      notes: sanitizePublicNotes(order.notes),
    },
    profile,
    client,
    vehicle,
  });
});

// ===== DELETE =====
app.delete(`${P}/clients/:id`, async (c) => {
  const user = await getUser(c.req.header("Authorization"));
  if (!user) return unauthorized(c);

  const blocked = await requireActiveSubscription(c, user);
  if (blocked) return blocked;
  const id = c.req.param("id");
  if (!isUuid(id)) return badRequest(c, "Cliente invÃ¡lido");
  const { error } = await svc()
    .from("af_clients")
    .delete()
    .eq("id", id)
    .eq("workshop_id", user.id);
  if (error) return serverError(c, error);
  return c.json({ ok: true });
});

// â”€â”€â”€ Vehicles â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

app.get(`${P}/vehicles`, async (c) => {
  const user = await getUser(c.req.header("Authorization"));
  if (!user) return unauthorized(c);

  const blocked = await requireActiveSubscription(c, user);
  if (blocked) return blocked;
  const { data, error } = await svc()
    .from("af_vehicles")
    .select("*")
    .eq("workshop_id", user.id)
    .order("created_at", { ascending: false });
  if (error) return serverError(c, error);
  return c.json(data ?? []);
});

app.post(`${P}/vehicles`, async (c) => {
  const user = await getUser(c.req.header("Authorization"));
  if (!user) return unauthorized(c);

  const blocked = await requireActiveSubscription(c, user);
  if (blocked) return blocked;
  const parsed = await readJsonObject(c);
  if (parsed.response) return parsed.response;
  const body = parsed.body;
  const plate = textValue(body.plate, 16);
  const brand = textValue(body.brand, 80);
  const model = textValue(body.model, 120);
  const year = textValue(body.year, 8);
  if (!plate) return badRequest(c, "Placa Ã© obrigatÃ³ria");
  if (!isUuid(body.client_id)) return badRequest(c, "Cliente invÃ¡lido");
  if ([brand, model, year].some((v) => v === null)) return badRequest(c, "Dados do veÃ­culo invÃ¡lidos ou muito longos");
  // Verify client belongs to this workshop
  const { data: clientCheck } = await svc()
    .from("af_clients")
    .select("id")
    .eq("id", body.client_id)
    .eq("workshop_id", user.id)
    .maybeSingle();
  if (!clientCheck) return c.json({ error: "Cliente nÃ£o encontrado" }, 404);
  const { data, error } = await svc()
    .from("af_vehicles")
    .insert({
      workshop_id: user.id,
      client_id: body.client_id,
      plate: body.plate.trim().toUpperCase(),
      brand: body.brand ?? "",
      model: body.model ?? "",
      year: body.year ?? "",
    })
    .select()
    .single();
  if (error) return serverError(c, error);
  return c.json(data, 201);
});

app.put(`${P}/vehicles/:id`, async (c) => {
  const user = await getUser(c.req.header("Authorization"));
  if (!user) return unauthorized(c);

  const blocked = await requireActiveSubscription(c, user);
  if (blocked) return blocked;
  const id = c.req.param("id");
  if (!isUuid(id)) return badRequest(c, "VeÃ­culo invÃ¡lido");
  const parsed = await readJsonObject(c);
  if (parsed.response) return parsed.response;
  const body = parsed.body;
  const plate = textValue(body.plate, 16);
  const brand = textValue(body.brand, 80);
  const model = textValue(body.model, 120);
  const year = textValue(body.year, 8);
  const mileage = textValue(body.mileage, 32);
  if (!plate) return badRequest(c, "Placa Ã© obrigatÃ³ria");
  if (!isUuid(body.client_id)) return badRequest(c, "Cliente invÃ¡lido");
  if ([brand, model, year, mileage].some((v) => v === null)) return badRequest(c, "Dados do veÃ­culo invÃ¡lidos ou muito longos");

  const { data: clientCheck } = await svc()
    .from("af_clients")
    .select("id")
    .eq("id", body.client_id)
    .eq("workshop_id", user.id)
    .maybeSingle();
  if (!clientCheck) return c.json({ error: "Cliente nÃ£o encontrado" }, 404);

  const { data, error } = await svc()
    .from("af_vehicles")
    .update({
      client_id: body.client_id,
      plate: plate.toUpperCase(),
      brand,
      model,
      year,
      mileage,
    })
    .eq("id", id)
    .eq("workshop_id", user.id)
    .select()
    .single();
  if (error) return serverError(c, error);
  if (!data) return c.json({ error: "Not found" }, 404);
  return c.json(data);
});

app.delete(`${P}/vehicles/:id`, async (c) => {
  const user = await getUser(c.req.header("Authorization"));
  if (!user) return unauthorized(c);

  const blocked = await requireActiveSubscription(c, user);
  if (blocked) return blocked;
  const id = c.req.param("id");
  if (!isUuid(id)) return badRequest(c, "VeÃ­culo invÃ¡lido");
  const { error } = await svc()
    .from("af_vehicles")
    .delete()
    .eq("id", id)
    .eq("workshop_id", user.id);
  if (error) return serverError(c, error);
  return c.json({ ok: true });
});

// â”€â”€â”€ Financial â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

app.get(`${P}/financial`, async (c) => {
  const user = await getUser(c.req.header("Authorization"));
  if (!user) return unauthorized(c);

  const blocked = await requireActiveSubscription(c, user);
  if (blocked) return blocked;

  const { data, error } = await svc()
    .from("af_financial_entries")
    .select("*")
    .eq("workshop_id", user.id)
    .order("created_at", { ascending: false });

  if (error) return serverError(c, error);

  return c.json(data ?? []);
});

app.post(`${P}/financial`, async (c) => {
  const user = await getUser(c.req.header("Authorization"));
  if (!user) return unauthorized(c);

  const blocked = await requireActiveSubscription(c, user);
  if (blocked) return blocked;

  const parsed = await readJsonObject(c);
  if (parsed.response) return parsed.response;
  const body = parsed.body;
  const description = textValue(body.description, 240);
  const category = textValue(body.category, 120);
  const amount = finiteAmount(body.amount);
  const type = body.type;

  if (!description) return badRequest(c, "DescriÃ§Ã£o Ã© obrigatÃ³ria");
  if (category === null) return badRequest(c, "Categoria invÃ¡lida ou muito longa");
  if (amount === null || amount <= 0) return badRequest(c, "Valor financeiro invÃ¡lido");
  if (type !== "income" && type !== "expense") return badRequest(c, "Tipo financeiro invÃ¡lido");

  const { data, error } = await svc()
    .from("af_financial_entries")
    .insert({
      workshop_id: user.id,
      description,
      amount,
      type,
      category,
    })
    .select()
    .single();

  if (error) return serverError(c, error);

  return c.json(data);
});

app.delete(`${P}/financial/:id`, async (c) => {
  const user = await getUser(c.req.header("Authorization"));
  if (!user) return unauthorized(c);

  const blocked = await requireActiveSubscription(c, user);
  if (blocked) return blocked;

  const id = c.req.param("id");
  if (!isUuid(id)) return badRequest(c, "LanÃ§amento invÃ¡lido");

  const { error } = await svc()
    .from("af_financial_entries")
    .delete()
    .eq("id", id)
    .eq("workshop_id", user.id);

  if (error) return serverError(c, error);

  return c.json({ ok: true });
});

// â”€â”€â”€ Service Orders â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

app.get(`${P}/orders`, async (c) => {
  const user = await getUser(c.req.header("Authorization"));
  if (!user) return unauthorized(c);

  const blocked = await requireActiveSubscription(c, user);
  if (blocked) return blocked;
  const { data, error } = await svc()
    .from("af_service_orders")
    .select("*")
    .eq("workshop_id", user.id)
    .order("updated_at", { ascending: false });
  if (error) return serverError(c, error);
  return c.json(data ?? []);
});

app.post(`${P}/orders`, async (c) => {
  const user = await getUser(c.req.header("Authorization"));
  if (!user) return unauthorized(c);

  const blocked = await requireActiveSubscription(c, user);
  if (blocked) return blocked;
  const parsed = await readJsonObject(c, 96 * 1024);
  if (parsed.response) return parsed.response;
  const body = parsed.body;
  if (!isUuid(body.client_id)) return badRequest(c, "Cliente invÃ¡lido");
  if (!isUuid(body.vehicle_id)) return badRequest(c, "VeÃ­culo invÃ¡lido");
  const reportedIssue = textValue(body.reported_issue, 4000);
  const employeeName = textValue(body.employee_name, 160);
  const servicesPerformed = textValue(body.services_performed, 12000, false);
  const notes = textValue(body.notes, 24000, false);
  const checklist = textValue(body.checklist, 12000, false);
  const deliveryDate = safeDateValue(body.delivery_date);
  const valueAmount = finiteAmount(body.value);
  const status = body.status ?? "aguardando";
  if (!reportedIssue) return badRequest(c, "Problema relatado Ã© obrigatÃ³rio");
  if ([employeeName, servicesPerformed, notes, checklist, deliveryDate].some((v) => v === null)) {
    return badRequest(c, "Dados da OS invÃ¡lidos ou muito longos");
  }
  if (valueAmount === null) return badRequest(c, "Valor da OS invÃ¡lido");
  if (!["aguardando", "em_manutencao", "finalizado"].includes(status)) return badRequest(c, "Status invÃ¡lido");
  // Verify client + vehicle belong to this workshop
  const { data: clientCheck } = await svc()
    .from("af_clients")
    .select("id")
    .eq("id", body.client_id)
    .eq("workshop_id", user.id)
    .maybeSingle();
  if (!clientCheck) return c.json({ error: "Cliente nÃ£o encontrado" }, 404);

  const { data: vCheck } = await svc()
    .from("af_vehicles")
    .select("id")
    .eq("id", body.vehicle_id)
    .eq("client_id", body.client_id)
    .eq("workshop_id", user.id)
    .maybeSingle();
  if (!vCheck)
    return c.json({ error: "VeÃ­culo nÃ£o encontrado para este cliente" }, 404);
  const now = new Date().toISOString();

  const orderInsert: Record<string, any> = {
    public_token: crypto.randomUUID(),
    workshop_id: user.id,
    client_id: body.client_id,
    vehicle_id: body.vehicle_id,
    reported_issue: reportedIssue,
    employee_name: employeeName,
    services_performed: servicesPerformed,
    value: String(valueAmount),
    status,
    notes,
    created_at: now,
    updated_at: now,
  };

  if (deliveryDate) orderInsert.delivery_date = deliveryDate;
  if (checklist) orderInsert.checklist = checklist;

  const { data, error } = await svc()
    .from("af_service_orders")
    .insert(orderInsert)
    .select()
    .single();
  if (error) return serverError(c, error);
  return c.json(data, 201);
});

app.put(`${P}/orders/:id`, async (c) => {
  const user = await getUser(c.req.header("Authorization"));
  if (!user) return unauthorized(c);

  const blocked = await requireActiveSubscription(c, user);
  if (blocked) return blocked;
  const id = c.req.param("id");
  if (!isUuid(id)) return badRequest(c, "OS invÃ¡lida");
  const parsed = await readJsonObject(c, 96 * 1024);
  if (parsed.response) return parsed.response;
  const body = parsed.body;
  const patch: Record<string, any> = { updated_at: new Date().toISOString() };

  if (body.reported_issue !== undefined) {
    const value = textValue(body.reported_issue, 4000);
    if (!value) return badRequest(c, "Problema relatado invÃ¡lido");
    patch.reported_issue = value;
  }
  if (body.employee_name !== undefined) {
    const value = textValue(body.employee_name, 160);
    if (value === null) return badRequest(c, "FuncionÃ¡rio invÃ¡lido");
    patch.employee_name = value;
  }
  if (body.services_performed !== undefined) {
    const value = textValue(body.services_performed, 12000, false);
    if (value === null) return badRequest(c, "ServiÃ§os executados invÃ¡lidos");
    patch.services_performed = value;
  }
  if (body.value !== undefined) {
    const amount = finiteAmount(body.value);
    if (amount === null) return badRequest(c, "Valor da OS invÃ¡lido");
    patch.value = String(amount);
  }
  if (body.status !== undefined) {
    if (!["aguardando", "em_manutencao", "finalizado"].includes(body.status)) return badRequest(c, "Status invÃ¡lido");
    patch.status = body.status;
  }
  if (body.notes !== undefined) {
    const value = textValue(body.notes, 24000, false);
    if (value === null) return badRequest(c, "ObservaÃ§Ãµes invÃ¡lidas");
    patch.notes = value;
  }
  if (body.delivery_date !== undefined) {
    const value = safeDateValue(body.delivery_date);
    if (value === null) return badRequest(c, "Data de entrega invÃ¡lida");
    patch.delivery_date = value || null;
  }
  if (body.checklist !== undefined) {
    const value = textValue(body.checklist, 12000, false);
    if (value === null) return badRequest(c, "Checklist invÃ¡lido");
    patch.checklist = value;
  }

  const { data, error } = await svc()
    .from("af_service_orders")
    .update(patch)
    .eq("id", id)
    .eq("workshop_id", user.id)
    .select()
    .single();
  if (error) return serverError(c, error);
  if (!data) return c.json({ error: "Not found" }, 404);
  return c.json(data);
});

app.delete(`${P}/orders/:id`, async (c) => {
  const user = await getUser(c.req.header("Authorization"));
  if (!user) return unauthorized(c);

  const blocked = await requireActiveSubscription(c, user);
  if (blocked) return blocked;
  const id = c.req.param("id");
  if (!isUuid(id)) return badRequest(c, "OS invÃ¡lida");
  const { error } = await svc()
    .from("af_service_orders")
    .delete()
    .eq("id", id)
    .eq("workshop_id", user.id);
  if (error) return serverError(c, error);

  return c.json({ ok: true });
});

type AccessStatus =
  | "active"
  | "trial"
  | "pending"
  | "expired"
  | "canceled"
  | "inactive";

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function addMonths(date: Date, months: number) {
  const result = new Date(date);
  const originalDay = result.getDate();
  result.setDate(1);
  result.setMonth(result.getMonth() + months);
  const lastDay = new Date(
    result.getFullYear(),
    result.getMonth() + 1,
    0,
  ).getDate();
  result.setDate(Math.min(originalDay, lastDay));
  return result;
}

function sanitizePublicNotes(value: unknown) {
  const text = String(value ?? "");
  const marker = "[VORTAN_ORCAMENTO]";
  const markerIndex = text.indexOf(marker);
  return (markerIndex >= 0 ? text.slice(0, markerIndex) : text).trim();
}

async function syncAccessState(params: {
  userId: string;
  status: AccessStatus;
  expiresAt: Date;
  email?: string | null;
  paymentId?: string | null;
  subscriptionPatch?: Record<string, unknown>;
}) {
  const subscriptionPayload: Record<string, unknown> = {
    user_id: params.userId,
    plan_name: "mensal",
    status: params.status,
    expires_at: params.expiresAt.toISOString(),
    ...(params.subscriptionPatch ?? {}),
  };

  const { error: subscriptionError } = await svc()
    .from("subscriptions")
    .upsert(subscriptionPayload, { onConflict: "user_id" });

  if (subscriptionError) throw subscriptionError;

  const profilePayload: Record<string, unknown> = {
    plan:
      params.status === "active"
        ? "active"
        : params.status === "trial"
          ? "trial"
          : "inactive",
    subscription_status: params.status,
    subscription_ends_at: params.expiresAt.toISOString(),
  };

  if (params.paymentId !== undefined) {
    profilePayload.mercadopago_payment_id = params.paymentId;
  }
  if (params.email !== undefined) profilePayload.email = params.email;

  const { data: profile, error: profileError } = await svc()
    .from("af_profiles")
    .update(profilePayload)
    .eq("id", params.userId)
    .select("id")
    .maybeSingle();

  if (profileError) throw profileError;
  if (!profile) throw new Error("Perfil da oficina nÃ£o encontrado");
}

async function activateTrialAccess(params: {
  userId: string;
  email?: string | null;
}) {
  const { data: existingSubscription, error: findError } = await svc()
    .from("subscriptions")
    .select("id, status, trial_used, trial_ends_at")
    .eq("user_id", params.userId)
    .maybeSingle();

  if (findError) throw findError;
  if (existingSubscription?.status === "active") return;
  if (existingSubscription?.status === "trial") return;
  if (existingSubscription?.trial_used === true) return;

  const now = new Date();
  const trialEndsAt = new Date(now);
  trialEndsAt.setDate(trialEndsAt.getDate() + 15);

  await syncAccessState({
    userId: params.userId,
    email: params.email,
    status: "trial",
    expiresAt: trialEndsAt,
    subscriptionPatch: {
      trial_started_at: now.toISOString(),
      trial_ends_at: trialEndsAt.toISOString(),
      trial_used: true,
      provider_status: "trial",
      cancel_at_period_end: false,
      canceled_at: null,
    },
  });
}

function getMercadoPagoToken() {
  const accessToken = Deno.env.get("MERCADOPAGO_ACCESS_TOKEN");
  if (!accessToken) throw new Error("Mercado Pago token nÃ£o configurado");
  return accessToken;
}

async function mercadoPagoGet(path: string) {
  const response = await fetch(`https://api.mercadopago.com${path}`, {
    headers: { Authorization: `Bearer ${getMercadoPagoToken()}` },
  });
  const data = await response.json().catch(() => null);
  return { response, data };
}

function hexToBytes(value: string) {
  if (!/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function timingSafeEqualHex(left: string, right: string) {
  const leftBytes = hexToBytes(left);
  const rightBytes = hexToBytes(right);
  if (!leftBytes || !rightBytes || leftBytes.length !== rightBytes.length)
    return false;

  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}

async function validateMercadoPagoWebhookSignature(c: any, dataId: string) {
  const secret = Deno.env.get("MERCADOPAGO_WEBHOOK_SECRET");
  if (!secret) {
    throw new Error("MERCADOPAGO_WEBHOOK_SECRET nÃ£o configurado");
  }

  const signatureHeader = c.req.header("x-signature") ?? "";
  const requestId = c.req.header("x-request-id") ?? "";
  let timestamp = "";
  let receivedHash = "";

  for (const part of signatureHeader.split(",")) {
    const [rawKey, ...rawValue] = part.split("=");
    const key = rawKey?.trim();
    const value = rawValue.join("=").trim();
    if (key === "ts") timestamp = value;
    if (key === "v1") receivedHash = value;
  }

  if (!timestamp || !receivedHash) return false;

  const timestampNumber = Number(timestamp);
  if (!Number.isFinite(timestampNumber)) return false;
  const timestampMs = timestampNumber > 10_000_000_000 ? timestampNumber : timestampNumber * 1000;
  if (Math.abs(Date.now() - timestampMs) > 15 * 60 * 1000) return false;

  const manifestParts: string[] = [];
  const normalizedDataId = dataId.trim().toLowerCase();
  if (normalizedDataId) manifestParts.push(`id:${normalizedDataId}`);
  if (requestId) manifestParts.push(`request-id:${requestId}`);
  manifestParts.push(`ts:${timestamp}`);
  const manifest = `${manifestParts.join(";")};`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(manifest),
  );
  const calculatedHash = Array.from(new Uint8Array(signed))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  return timingSafeEqualHex(calculatedHash, receivedHash.toLowerCase());
}

function webhookEventKey(params: {
  topic: string;
  resourceId: string;
  notificationId: string;
  action: string;
  createdAt: string;
  requestId: string;
}) {
  if (params.notificationId) {
    return `${params.topic}:notification:${params.notificationId}`;
  }
  return [
    params.topic,
    params.resourceId,
    params.action || "no-action",
    params.createdAt || params.requestId || "no-date",
  ].join(":");
}

async function claimWebhookEvent(params: {
  topic: string;
  resourceId: string;
  notificationId: string;
  action: string;
  createdAt: string;
  requestId: string;
  payload: unknown;
}) {
  const eventKey = webhookEventKey(params);
  const database = svc();
  const now = new Date().toISOString();
  const { data, error } = await database
    .from("billing_webhook_events")
    .insert({
      provider: "mercadopago",
      event_key: eventKey,
      topic: params.topic,
      resource_id: params.resourceId,
      notification_id: params.notificationId || null,
      request_id: params.requestId || null,
      status: "processing",
      attempts: 1,
      payload: params.payload,
      updated_at: now,
    })
    .select("id")
    .single();

  if (!error && data) {
    return { id: data.id as string, duplicate: false };
  }
  if (error?.code !== "23505") throw error;

  const { data: existing, error: existingError } = await database
    .from("billing_webhook_events")
    .select("id, status, attempts, updated_at")
    .eq("provider", "mercadopago")
    .eq("event_key", eventKey)
    .single();

  if (existingError) throw existingError;
  if (existing.status === "processed") {
    return { id: existing.id as string, duplicate: true };
  }

  const lastUpdate = new Date(existing.updated_at).getTime();
  const processingIsFresh =
    existing.status === "processing" &&
    Number.isFinite(lastUpdate) &&
    Date.now() - lastUpdate < 5 * 60 * 1000;

  if (processingIsFresh) {
    return { id: existing.id as string, duplicate: true };
  }

  const { error: retryError } = await database
    .from("billing_webhook_events")
    .update({
      status: "processing",
      attempts: Number(existing.attempts ?? 0) + 1,
      error_message: null,
      payload: params.payload,
      request_id: params.requestId || null,
      updated_at: now,
    })
    .eq("id", existing.id);

  if (retryError) throw retryError;
  return { id: existing.id as string, duplicate: false };
}

async function finishWebhookEvent(eventId: string) {
  const { error } = await svc()
    .from("billing_webhook_events")
    .update({
      status: "processed",
      processed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      error_message: null,
    })
    .eq("id", eventId);
  if (error) throw error;
}

async function failWebhookEvent(eventId: string, errorMessage: string) {
  const { error } = await svc()
    .from("billing_webhook_events")
    .update({
      status: "failed",
      error_message: errorMessage.slice(0, 2000),
      updated_at: new Date().toISOString(),
    })
    .eq("id", eventId);
  if (error) console.error("Erro ao registrar falha do webhook:", error);
}

async function processApprovedPayment(paymentId: string) {
  const { response, data: payment } = await mercadoPagoGet(
    `/v1/payments/${encodeURIComponent(paymentId)}`,
  );

  if (!response.ok) {
    throw new Error(
      payment?.message ?? "Pagamento nÃ£o encontrado no Mercado Pago",
    );
  }

  if (payment?.status !== "approved") {
    return { ok: true, ignored: true, status: payment?.status ?? "unknown" };
  }

  const userId = String(payment?.external_reference ?? "");
  if (!isUuid(userId))
    throw new Error("Pagamento sem referÃªncia de usuÃ¡rio vÃ¡lida");

  const expectedCurrency = Deno.env.get("MERCADOPAGO_CURRENCY") ?? "BRL";
  const expectedAmount = Number(
    Deno.env.get("VORTAN_MONTHLY_PRICE") ?? "29.90",
  );
  const receivedAmount = Number(payment?.transaction_amount);

  if (payment?.currency_id !== expectedCurrency) {
    throw new Error("Moeda do pagamento invÃ¡lida");
  }
  if (
    !Number.isFinite(receivedAmount) ||
    Math.abs(receivedAmount - expectedAmount) > 0.009
  ) {
    throw new Error("Valor do pagamento invÃ¡lido");
  }

  const expectedCollector = Deno.env.get("MERCADOPAGO_COLLECTOR_ID");
  if (
    expectedCollector &&
    String(payment?.collector_id ?? "") !== expectedCollector
  ) {
    throw new Error("Recebedor do pagamento invÃ¡lido");
  }

  const { data: profile, error: profileError } = await svc()
    .from("af_profiles")
    .select("id, subscription_ends_at, mercadopago_payment_id")
    .eq("id", userId)
    .maybeSingle();

  if (profileError) throw profileError;
  if (!profile) throw new Error("UsuÃ¡rio do pagamento nÃ£o encontrado");

  const { data: subscription, error: subscriptionError } = await svc()
    .from("subscriptions")
    .select("status, expires_at")
    .eq("user_id", userId)
    .maybeSingle();

  if (subscriptionError) throw subscriptionError;

  const normalizedPaymentId = String(payment.id);
  const duplicate = profile.mercadopago_payment_id === normalizedPaymentId;

  if (duplicate) {
    const knownExpiration =
      profile.subscription_ends_at ?? subscription?.expires_at;
    const expiresAt = knownExpiration ? new Date(knownExpiration) : new Date();
    await syncAccessState({
      userId,
      email: payment?.payer?.email ?? undefined,
      paymentId: normalizedPaymentId,
      status: "active",
      expiresAt: Number.isNaN(expiresAt.getTime()) ? new Date() : expiresAt,
      subscriptionPatch: {
        provider_status: "approved",
        cancel_at_period_end: false,
        canceled_at: null,
      },
    });
    return { ok: true, duplicate: true };
  }

  const approvedAt = payment?.date_approved
    ? new Date(payment.date_approved)
    : new Date();
  const safeApprovedAt = Number.isNaN(approvedAt.getTime())
    ? new Date()
    : approvedAt;
  const existingExpiration = subscription?.expires_at
    ? new Date(subscription.expires_at)
    : null;
  const baseDate =
    existingExpiration &&
    !Number.isNaN(existingExpiration.getTime()) &&
    existingExpiration.getTime() > safeApprovedAt.getTime()
      ? existingExpiration
      : safeApprovedAt;
  const expiresAt = addMonths(baseDate, 1);

  await syncAccessState({
    userId,
    email: payment?.payer?.email ?? undefined,
    paymentId: normalizedPaymentId,
    status: "active",
    expiresAt,
    subscriptionPatch: {
      provider_status: "approved",
      cancel_at_period_end: false,
      canceled_at: null,
    },
  });

  return { ok: true, expires_at: expiresAt.toISOString() };
}

async function processPreapproval(preapprovalId: string) {
  const { response, data: preapproval } = await mercadoPagoGet(
    `/preapproval/${encodeURIComponent(preapprovalId)}`,
  );

  if (!response.ok) {
    throw new Error(
      preapproval?.message ?? "Assinatura nÃ£o encontrada no Mercado Pago",
    );
  }

  const userId = String(preapproval?.external_reference ?? "");
  if (!isUuid(userId))
    throw new Error("Assinatura sem referÃªncia de usuÃ¡rio vÃ¡lida");

  const expectedPlanId = Deno.env.get("MERCADOPAGO_PREAPPROVAL_PLAN_ID");
  if (expectedPlanId && preapproval?.preapproval_plan_id !== expectedPlanId) {
    throw new Error("Plano da assinatura invÃ¡lido");
  }

  const current = await getSubscription(userId);
  const providerStatus = String(preapproval?.status ?? "unknown");
  const currentExpiration = current?.expires_at
    ? new Date(current.expires_at)
    : new Date();
  const safeExpiration = Number.isNaN(currentExpiration.getTime())
    ? new Date()
    : currentExpiration;
  const stillHasAccess = isSubscriptionActive(current);

  if (["cancelled", "canceled", "paused"].includes(providerStatus)) {
    if (stillHasAccess) {
      const { error } = await svc()
        .from("subscriptions")
        .upsert(
          {
            user_id: userId,
            plan_name: "mensal",
            status: current.status,
            expires_at: safeExpiration.toISOString(),
            preapproval_id: String(preapproval.id),
            mercadopago_subscription_id: String(preapproval.id),
            provider_status: providerStatus,
            cancel_at_period_end: true,
            canceled_at: new Date().toISOString(),
          },
          { onConflict: "user_id" },
        );
      if (error) throw error;
    } else {
      await syncAccessState({
        userId,
        status: "canceled",
        expiresAt: new Date(),
        subscriptionPatch: {
          preapproval_id: String(preapproval.id),
          mercadopago_subscription_id: String(preapproval.id),
          provider_status: providerStatus,
          cancel_at_period_end: true,
          canceled_at: new Date().toISOString(),
        },
      });
    }
  } else {
    const status: AccessStatus = stillHasAccess ? current.status : "pending";
    const { error } = await svc()
      .from("subscriptions")
      .upsert(
        {
          user_id: userId,
          plan_name: "mensal",
          status,
          expires_at: safeExpiration.toISOString(),
          preapproval_id: String(preapproval.id),
          mercadopago_subscription_id: String(preapproval.id),
          provider_status: providerStatus,
          cancel_at_period_end: false,
          canceled_at: null,
        },
        { onConflict: "user_id" },
      );
    if (error) throw error;
  }

  return { ok: true, provider_status: providerStatus };
}

// â”€â”€â”€ Billing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

app.post(`${P}/billing/create-checkout`, async (c) => {
  try {
    const user = await getUser(c.req.header("Authorization"));
    if (!user) return unauthorized(c);

    const response = await fetch(
      "https://api.mercadopago.com/checkout/preferences",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${getMercadoPagoToken()}`,
          "Content-Type": "application/json",
          "X-Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          items: [
            {
              id: "vortan-oficina-mensal",
              title: "Assinatura Vortan Oficina - 1 mÃªs",
              quantity: 1,
              currency_id: "BRL",
              unit_price: Number(
                Deno.env.get("VORTAN_MONTHLY_PRICE") ?? "29.90",
              ),
            },
          ],
          external_reference: user.id,
          metadata: {
            product_code: "vortan_oficina_monthly",
            user_id: user.id,
          },
          payer: { email: user.email },
          back_urls: {
            success: "https://www.vortanoficina.com.br",
            failure: "https://www.vortanoficina.com.br",
            pending: "https://www.vortanoficina.com.br",
          },
          auto_return: "approved",
          notification_url:
            "https://kddlzartfawqjnrafzdb.supabase.co/functions/v1/rapid-action/billing/webhook?source_news=webhooks",
        }),
      },
    );

    const data = await response.json().catch(() => null);
    if (!response.ok) {
      return c.json(
        { error: "Erro ao criar pagamento" },
        502,
      );
    }

    return c.json({
      id: data.id,
      checkout_url: data.init_point,
      init_point: data.init_point,
      url: data.init_point,
    });
  } catch (error: any) {
    return serverError(c, error?.message ?? "Erro ao criar pagamento");
  }
});

app.post(`${P}/billing/create-subscription`, async (c) => {
  try {
    const user = await getUser(c.req.header("Authorization"));
    if (!user) return unauthorized(c);
    if (!user.email) return badRequest(c, "UsuÃ¡rio sem e-mail vÃ¡lido");

    const planId = Deno.env.get("MERCADOPAGO_PREAPPROVAL_PLAN_ID");
    if (!planId)
      return serverError(c, "ID do plano recorrente nÃ£o configurado");

    const existing = await getSubscription(user.id);
    if (existing?.preapproval_id) {
      const existingPreapproval = await mercadoPagoGet(
        `/preapproval/${encodeURIComponent(existing.preapproval_id)}`,
      );
      const existingData = existingPreapproval.data;
      if (
        existingPreapproval.response.ok &&
        String(existingData?.external_reference ?? "") === user.id &&
        existingData?.init_point &&
        ["pending", "authorized", "paused"].includes(
          String(existingData?.status ?? ""),
        )
      ) {
        return c.json({
          id: existingData.id,
          init_point: existingData.init_point,
          url: existingData.init_point,
          reused: true,
        });
      }
    }

    const response = await fetch("https://api.mercadopago.com/preapproval", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getMercadoPagoToken()}`,
        "Content-Type": "application/json",
        "X-Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        preapproval_plan_id: planId,
        reason: "Assinatura mensal Vortan Oficina",
        external_reference: user.id,
        payer_email: user.email,
        back_url: "https://www.vortanoficina.com.br",
        status: "pending",
      }),
    });

    const raw = await response.text();

    let data: any = null;

    try {
      data = JSON.parse(raw);
    } catch {
      data = { raw };
    }

    if (!response.ok) {
      return c.json(
        {
          error: data?.message ?? "Erro ao criar assinatura recorrente",
          status: response.status,
          statusText: response.statusText,
          details: data,
        },
        502,
      );
    }
    if (!data?.id || !data?.init_point) {
      return serverError(
        c,
        "Mercado Pago nÃ£o retornou a assinatura corretamente",
      );
    }

    const keepCurrentAccess = isSubscriptionActive(existing);
    const expiresAt = existing?.expires_at ?? new Date().toISOString();
    const { error } = await svc()
      .from("subscriptions")
      .upsert(
        {
          user_id: user.id,
          plan_name: "mensal",
          status: keepCurrentAccess ? existing.status : "pending",
          expires_at: expiresAt,
          preapproval_id: String(data.id),
          mercadopago_subscription_id: String(data.id),
          provider_status: String(data.status ?? "pending"),
          cancel_at_period_end: false,
          canceled_at: null,
        },
        { onConflict: "user_id" },
      );

    if (error) return serverError(c, error);

    return c.json({
      id: data.id,
      init_point: data.init_point,
      url: data.init_point,
    });
  } catch (error: any) {
    return serverError(c, error?.message ?? "Erro ao criar assinatura");
  }
});

app.post(`${P}/billing/webhook`, async (c) => {
  let claimedEventId: string | null = null;

  try {
    const parsed = await readJsonObject(c, 256 * 1024);
    if (parsed.response) return parsed.response;
    const body = parsed.body;
    const topic = String(
      body?.type ?? c.req.query("type") ?? c.req.query("topic") ?? "payment",
    );
    const resourceId = String(
      body?.data?.id ??
        c.req.query("data.id") ??
        c.req.query("data_id") ??
        body?.id ??
        c.req.query("id") ??
        "",
    );
    const signatureDataId = String(
      c.req.query("data.id") ?? c.req.query("data_id") ?? body?.data?.id ?? "",
    );

    if (!resourceId) return badRequest(c, "NotificaÃ§Ã£o sem ID");

    const validSignature = await validateMercadoPagoWebhookSignature(
      c,
      signatureDataId,
    );
    if (!validSignature) {
      return c.json(
        { ok: false, error: "Assinatura do webhook invÃ¡lida" },
        401,
      );
    }

    const requestId = c.req.header("x-request-id") ?? "";
    const claim = await claimWebhookEvent({
      topic,
      resourceId,
      notificationId: String(body?.id ?? ""),
      action: String(body?.action ?? ""),
      createdAt: String(body?.date_created ?? ""),
      requestId,
      payload: body,
    });
    claimedEventId = claim.id;

    if (claim.duplicate) {
      return c.json({ ok: true, duplicate: true });
    }

    let result: Record<string, unknown>;

    if (topic === "subscription_preapproval") {
      result = await processPreapproval(resourceId);
    } else if (topic === "subscription_authorized_payment") {
      const invoice = await mercadoPagoGet(
        `/authorized_payments/${encodeURIComponent(resourceId)}`,
      );
      if (!invoice.response.ok) {
        throw new Error(invoice.data?.message ?? "Fatura nÃ£o encontrada");
      }
      const linkedPaymentId = invoice.data?.payment?.id;
      if (!linkedPaymentId || invoice.data?.payment?.status !== "approved") {
        result = {
          ok: true,
          ignored: true,
          status:
            invoice.data?.payment?.status ?? invoice.data?.status ?? "unknown",
        };
      } else {
        result = await processApprovedPayment(String(linkedPaymentId));
      }
    } else if (topic !== "payment" && topic !== "topic_payment") {
      result = { ok: true, ignored: true, topic };
    } else {
      result = await processApprovedPayment(resourceId);
    }

    await finishWebhookEvent(claimedEventId);
    return c.json(result);
  } catch (error: any) {
    const errorMessage = error?.message ?? "Erro ao processar notificaÃ§Ã£o";
    if (claimedEventId) await failWebhookEvent(claimedEventId, errorMessage);
    console.error("Erro no webhook do Mercado Pago:", error);
    return c.json({ ok: false, error: "Erro ao processar notificaÃ§Ã£o" }, 500);
  }
});

app.post(`${P}/billing/cancel-subscription`, async (c) => {
  try {
    const user = await getUser(c.req.header("Authorization"));
    if (!user) return unauthorized(c);

    const sub = await getSubscription(user.id);
    if (!sub?.preapproval_id) {
      return c.json({ error: "Assinatura recorrente nÃ£o encontrada." }, 404);
    }

    const response = await fetch(
      `https://api.mercadopago.com/preapproval/${encodeURIComponent(sub.preapproval_id)}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${getMercadoPagoToken()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ status: "cancelled" }),
      },
    );

    const data = await response.json().catch(() => null);
    if (!response.ok) {
      return c.json(
        { error: "Erro ao cancelar assinatura no Mercado Pago." },
        502,
      );
    }

    const expiresAt = sub.expires_at ? new Date(sub.expires_at) : new Date();
    const safeExpiration = Number.isNaN(expiresAt.getTime())
      ? new Date()
      : expiresAt;
    const stillHasAccess =
      safeExpiration.getTime() > Date.now() &&
      ["active", "trial"].includes(sub.status);

    if (stillHasAccess) {
      const { error } = await svc()
        .from("subscriptions")
        .update({
          provider_status: "cancelled",
          cancel_at_period_end: true,
          canceled_at: new Date().toISOString(),
        })
        .eq("user_id", user.id);
      if (error) throw error;
    } else {
      await syncAccessState({
        userId: user.id,
        status: "canceled",
        expiresAt: safeExpiration,
        subscriptionPatch: {
          provider_status: "cancelled",
          cancel_at_period_end: true,
          canceled_at: new Date().toISOString(),
        },
      });
    }

    return c.json({
      ok: true,
      message: stillHasAccess
        ? "Assinatura cancelada. VocÃª continuarÃ¡ com acesso atÃ© o fim do perÃ­odo pago."
        : "Assinatura cancelada.",
      expires_at: sub.expires_at,
    });
  } catch (error: any) {
    console.error("Erro ao cancelar assinatura:", error);
    return serverError(
      c,
      error?.message ?? "Erro interno ao cancelar assinatura",
    );
  }
});

Deno.serve(app.fetch);




