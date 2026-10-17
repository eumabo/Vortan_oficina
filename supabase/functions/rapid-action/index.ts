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
    return c.json({ error: "Muitas requisições. Tente novamente em instantes." }, 429);
  }
  return null;
}

app.use("*", async (c, next) => {
  const limited = checkRateLimit(c);
  if (limited) return limited;
  await next();
});

// ─── Helpers ────────────────────────────────────────────────────────────────

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
    return { body: null, response: c.json({ error: "Requisição muito grande" }, 413) };
  }

  try {
    const body = await c.req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return { body: null, response: badRequest(c, "JSON inválido") };
    }
    const size = new TextEncoder().encode(JSON.stringify(body)).byteLength;
    if (size > maxBytes) {
      return { body: null, response: c.json({ error: "Requisição muito grande" }, 413) };
    }
    return { body, response: null };
  } catch {
    return { body: null, response: badRequest(c, "JSON inválido") };
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

function timingSafeEqualString(a: string, b: string) {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  const maxLength = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;

  for (let i = 0; i < maxLength; i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }

  return diff === 0;
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

// ─── Admin ───────────────────────────────────────────────────────────────────

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
  if (!isUuid(targetId)) return badRequest(c, "Oficina inválida");
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
  if (!targetProfile) return c.json({ error: "Oficina não encontrada" }, 404);

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
    return badRequest(c, "Ação administrativa inválida");
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
  if (!data) return c.json({ error: "Oficina não encontrada" }, 404);

  return c.json(data);
});

// ─── Health ──────────────────────────────────────────────────────────────────

app.get(`${P}/health`, (c) =>
  c.json({ status: "ok", ts: new Date().toISOString() }),
);

// ─── Profile ─────────────────────────────────────────────────────────────────

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

  if (!workshopName) return badRequest(c, "Nome da oficina é obrigatório");
  if ([ownerName, phone, whatsapp, instagram, address, city, state, logoUrl].some((v) => v === null)) {
    return badRequest(c, "Dados do perfil inválidos ou muito longos");
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
    console.error("Erro ao criar teste grátis:", trialError);
    return serverError(c, "Erro ao ativar teste grátis");
  }

  const { data: updatedProfile, error: profileError } = await svc()
    .from("af_profiles")
    .select()
    .eq("id", user.id)
    .single();

  if (profileError) return serverError(c, profileError);

  return c.json(updatedProfile);
});

// ─── Clients ─────────────────────────────────────────────────────────────────

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
  if (!name) return badRequest(c, "Nome é obrigatório");
  if (phone === null || whatsapp === null) return badRequest(c, "Contato inválido ou muito longo");
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
  if (!isUuid(id)) return badRequest(c, "Cliente inválido");
  const parsed = await readJsonObject(c);
  if (parsed.response) return parsed.response;
  const body = parsed.body;
  const name = textValue(body.name, 160);
  const phone = textValue(body.phone, 40);
  const whatsapp = textValue(body.whatsapp, 40);
  if (!name) return badRequest(c, "Nome é obrigatório");
  if (phone === null || whatsapp === null) return badRequest(c, "Contato inválido ou muito longo");
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

// ===== ROTA PÚBLICA DA OS =====
app.get(`${P}/public/orders/:token`, async (c) => {
  const token = c.req.param("token");
  if (!isUuid(token)) return badRequest(c, "Token inválido");

  const { data: order, error } = await svc()
    .from("af_service_orders")
    .select(
      "id, workshop_id, client_id, vehicle_id, status, value, delivery_date, reported_issue, services_performed, notes",
    )
    .eq("public_token", token)
    .maybeSingle();

  if (error) return serverError(c, error);
  if (!order) return c.json({ error: "OS não encontrada" }, 404);

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
  if (!isUuid(id)) return badRequest(c, "Cliente inválido");
  const { error } = await svc()
    .from("af_clients")
    .delete()
    .eq("id", id)
    .eq("workshop_id", user.id);
  if (error) return serverError(c, error);
  return c.json({ ok: true });
});

// ─── Vehicles ─────────────────────────────────────────────────────────────────

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
  if (!plate) return badRequest(c, "Placa é obrigatória");
  if (!isUuid(body.client_id)) return badRequest(c, "Cliente inválido");
  if ([brand, model, year].some((v) => v === null)) return badRequest(c, "Dados do veículo inválidos ou muito longos");
  // Verify client belongs to this workshop
  const { data: clientCheck } = await svc()
    .from("af_clients")
    .select("id")
    .eq("id", body.client_id)
    .eq("workshop_id", user.id)
    .maybeSingle();
  if (!clientCheck) return c.json({ error: "Cliente não encontrado" }, 404);
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
  if (!isUuid(id)) return badRequest(c, "Veículo inválido");
  const parsed = await readJsonObject(c);
  if (parsed.response) return parsed.response;
  const body = parsed.body;
  const plate = textValue(body.plate, 16);
  const brand = textValue(body.brand, 80);
  const model = textValue(body.model, 120);
  const year = textValue(body.year, 8);
  const mileage = textValue(body.mileage, 32);
  if (!plate) return badRequest(c, "Placa é obrigatória");
  if (!isUuid(body.client_id)) return badRequest(c, "Cliente inválido");
  if ([brand, model, year, mileage].some((v) => v === null)) return badRequest(c, "Dados do veículo inválidos ou muito longos");

  const { data: clientCheck } = await svc()
    .from("af_clients")
    .select("id")
    .eq("id", body.client_id)
    .eq("workshop_id", user.id)
    .maybeSingle();
  if (!clientCheck) return c.json({ error: "Cliente não encontrado" }, 404);

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
  if (!isUuid(id)) return badRequest(c, "Veículo inválido");
  const { error } = await svc()
    .from("af_vehicles")
    .delete()
    .eq("id", id)
    .eq("workshop_id", user.id);
  if (error) return serverError(c, error);
  return c.json({ ok: true });
});

// ─── Financial ─────────────────────────────────────────

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

  if (!description) return badRequest(c, "Descrição é obrigatória");
  if (category === null) return badRequest(c, "Categoria inválida ou muito longa");
  if (amount === null || amount <= 0) return badRequest(c, "Valor financeiro inválido");
  if (type !== "income" && type !== "expense") return badRequest(c, "Tipo financeiro inválido");

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
  if (!isUuid(id)) return badRequest(c, "Lançamento inválido");

  const { error } = await svc()
    .from("af_financial_entries")
    .delete()
    .eq("id", id)
    .eq("workshop_id", user.id);

  if (error) return serverError(c, error);

  return c.json({ ok: true });
});

// ─── Service Orders ───────────────────────────────────────────────────────────

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
  if (!isUuid(body.client_id)) return badRequest(c, "Cliente inválido");
  if (!isUuid(body.vehicle_id)) return badRequest(c, "Veículo inválido");
  const reportedIssue = textValue(body.reported_issue, 4000);
  const employeeName = textValue(body.employee_name, 160);
  const servicesPerformed = textValue(body.services_performed, 12000, false);
  const notes = textValue(body.notes, 24000, false);
  const checklist = textValue(body.checklist, 12000, false);
  const deliveryDate = safeDateValue(body.delivery_date);
  const valueAmount = finiteAmount(body.value);
  const status = body.status ?? "aguardando";
  if (!reportedIssue) return badRequest(c, "Problema relatado é obrigatório");
  if ([employeeName, servicesPerformed, notes, checklist, deliveryDate].some((v) => v === null)) {
    return badRequest(c, "Dados da OS inválidos ou muito longos");
  }
  if (valueAmount === null) return badRequest(c, "Valor da OS inválido");
  if (!["aguardando", "em_manutencao", "finalizado"].includes(status)) return badRequest(c, "Status inválido");
  // Verify client + vehicle belong to this workshop
  const { data: clientCheck } = await svc()
    .from("af_clients")
    .select("id")
    .eq("id", body.client_id)
    .eq("workshop_id", user.id)
    .maybeSingle();
  if (!clientCheck) return c.json({ error: "Cliente não encontrado" }, 404);

  const { data: vCheck } = await svc()
    .from("af_vehicles")
    .select("id")
    .eq("id", body.vehicle_id)
    .eq("client_id", body.client_id)
    .eq("workshop_id", user.id)
    .maybeSingle();
  if (!vCheck)
    return c.json({ error: "Veículo não encontrado para este cliente" }, 404);
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
  if (!isUuid(id)) return badRequest(c, "OS inválida");
  const parsed = await readJsonObject(c, 96 * 1024);
  if (parsed.response) return parsed.response;
  const body = parsed.body;
  const patch: Record<string, any> = { updated_at: new Date().toISOString() };

  if (body.reported_issue !== undefined) {
    const value = textValue(body.reported_issue, 4000);
    if (!value) return badRequest(c, "Problema relatado inválido");
    patch.reported_issue = value;
  }
  if (body.employee_name !== undefined) {
    const value = textValue(body.employee_name, 160);
    if (value === null) return badRequest(c, "Funcionário inválido");
    patch.employee_name = value;
  }
  if (body.services_performed !== undefined) {
    const value = textValue(body.services_performed, 12000, false);
    if (value === null) return badRequest(c, "Serviços executados inválidos");
    patch.services_performed = value;
  }
  if (body.value !== undefined) {
    const amount = finiteAmount(body.value);
    if (amount === null) return badRequest(c, "Valor da OS inválido");
    patch.value = String(amount);
  }
  if (body.status !== undefined) {
    if (!["aguardando", "em_manutencao", "finalizado"].includes(body.status)) return badRequest(c, "Status inválido");
    patch.status = body.status;
  }
  if (body.notes !== undefined) {
    const value = textValue(body.notes, 24000, false);
    if (value === null) return badRequest(c, "Observações inválidas");
    patch.notes = value;
  }
  if (body.delivery_date !== undefined) {
    const value = safeDateValue(body.delivery_date);
    if (value === null) return badRequest(c, "Data de entrega inválida");
    patch.delivery_date = value || null;
  }
  if (body.checklist !== undefined) {
    const value = textValue(body.checklist, 12000, false);
    if (value === null) return badRequest(c, "Checklist inválido");
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
  if (!isUuid(id)) return badRequest(c, "OS inválida");
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

  if (params.email !== undefined) profilePayload.email = params.email;

  const { data: profile, error: profileError } = await svc()
    .from("af_profiles")
    .update(profilePayload)
    .eq("id", params.userId)
    .select("id")
    .maybeSingle();

  if (profileError) throw profileError;
  if (!profile) throw new Error("Perfil da oficina não encontrado");
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

function getAsaasApiKey() {
  const apiKey = Deno.env.get("ASAAS_API_KEY");
  if (!apiKey) throw new Error("ASAAS_API_KEY não configurada");
  return apiKey;
}

function getAsaasApiUrl() {
  return (Deno.env.get("ASAAS_API_URL") ?? "https://api.asaas.com/v3").replace(/\/$/, "");
}

function getAppBaseUrl() {
  return (Deno.env.get("APP_BASE_URL") ?? "https://www.vortanoficina.com.br").replace(/\/$/, "");
}

function getMonthlyPrice() {
  const value = Number(Deno.env.get("VORTAN_MONTHLY_PRICE") ?? "29.90");
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("VORTAN_MONTHLY_PRICE inválido");
  }
  return value;
}

async function asaasRequest(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers ?? {});
  headers.set("accept", "application/json");
  headers.set("access_token", getAsaasApiKey());
  headers.set("User-Agent", "VortanOficina/1.0");
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`${getAsaasApiUrl()}${path}`, {
    ...init,
    headers,
  });
  const raw = await response.text();
  let data: any = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = { raw };
  }
  return { response, data };
}

function asaasCheckoutUrl(checkoutId: string, returnedUrl?: unknown) {
  const apiUrl = String(returnedUrl ?? "").trim();
  if (/^https:\/\//i.test(apiUrl)) return apiUrl;

  // O POST /checkouts retorna apenas o ID. No Sandbox, o link público real
  // usa o host/path abaixo (confirmado pelo evento CHECKOUT_CREATED).
  // Em produção, mantemos o formato oficial documentado pelo Asaas.
  if (getAsaasApiUrl().includes("api-sandbox.asaas.com")) {
    return `https://sandbox.asaas.com/000/checkoutSession/show/${encodeURIComponent(checkoutId)}`;
  }

  return `https://asaas.com/checkoutSession/show?id=${encodeURIComponent(checkoutId)}`;
}

function extractUuid(value: unknown) {
  const text = String(value ?? "");
  const match = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
  return match?.[0] && isUuid(match[0]) ? match[0] : null;
}


function formatAsaasDateTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

function formatAsaasDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function onlyDigits(value: unknown) {
  return String(value ?? "").replace(/\D/g, "");
}

function isValidCpf(value: string) {
  if (!/^\d{11}$/.test(value) || /^(\d)\1{10}$/.test(value)) return false;
  const calc = (length: number) => {
    let sum = 0;
    for (let i = 0; i < length; i += 1) sum += Number(value[i]) * (length + 1 - i);
    const mod = (sum * 10) % 11;
    return mod === 10 ? 0 : mod;
  };
  return calc(9) === Number(value[9]) && calc(10) === Number(value[10]);
}

function isValidCnpj(value: string) {
  if (!/^\d{14}$/.test(value) || /^(\d)\1{13}$/.test(value)) return false;
  const digit = (base: string, weights: number[]) => {
    const sum = base.split("").reduce((acc, n, i) => acc + Number(n) * weights[i], 0);
    const mod = sum % 11;
    return mod < 2 ? 0 : 11 - mod;
  };
  const base = value.slice(0, 12);
  const first = digit(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const second = digit(`${base}${first}`, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return value === `${base}${first}${second}`;
}

function isValidCpfCnpj(value: string) {
  return isValidCpf(value) || isValidCnpj(value);
}

async function getAsaasCustomer(customerId: string) {
  const { response, data } = await asaasRequest(`/customers/${encodeURIComponent(customerId)}`);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(
      data?.errors?.[0]?.description ?? data?.message ?? "Erro ao consultar cliente no Asaas",
    );
  }
  return data;
}

async function findAsaasCustomerByExternalReference(userId: string) {
  const query = new URLSearchParams({ externalReference: userId, limit: "1" });
  const { response, data } = await asaasRequest(`/customers?${query.toString()}`);
  if (!response.ok) {
    throw new Error(
      data?.errors?.[0]?.description ?? data?.message ?? "Erro ao localizar cliente no Asaas",
    );
  }
  const customer = Array.isArray(data?.data) ? data.data[0] : null;
  return customer?.id ? customer : null;
}

async function getPixCustomerForUser(user: any, cpfCnpj?: string) {
  const existing = await getSubscription(user.id);
  const latestCheckout = await getLatestAsaasCheckoutSession(user.id);
  const candidates = [
    String(existing?.provider_customer_id ?? "").trim(),
    String(latestCheckout?.customer_id ?? "").trim(),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const customer = await getAsaasCustomer(candidate);
    if (customer?.id) return String(customer.id);
  }

  const byReference = await findAsaasCustomerByExternalReference(user.id);
  if (byReference?.id) return String(byReference.id);

  const document = onlyDigits(cpfCnpj);
  if (!document) return null;
  if (!isValidCpfCnpj(document)) throw new Error("CPF/CNPJ inválido");

  const { data: profile, error: profileError } = await svc()
    .from("af_profiles")
    .select("owner_name, workshop_name, phone, whatsapp")
    .eq("id", user.id)
    .maybeSingle();
  if (profileError) throw profileError;

  const name =
    String(profile?.owner_name ?? "").trim() ||
    String(profile?.workshop_name ?? "").trim() ||
    String(user.email ?? "").split("@")[0] ||
    "Cliente Vortan";
  const mobilePhone = onlyDigits(profile?.whatsapp || profile?.phone).slice(-11);
  const payload: Record<string, unknown> = {
    name: name.slice(0, 120),
    cpfCnpj: document,
    externalReference: user.id,
    notificationDisabled: true,
  };
  if (user.email) payload.email = String(user.email).slice(0, 160);
  if (mobilePhone.length >= 10) payload.mobilePhone = mobilePhone;

  const created = await asaasRequest("/customers", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (!created.response.ok || !created.data?.id) {
    throw new Error(
      created.data?.errors?.[0]?.description ??
        created.data?.message ??
        "Não foi possível cadastrar o pagador no Asaas",
    );
  }

  return String(created.data.id);
}

async function createAsaasPixPayment(user: any, cpfCnpj?: string) {
  const price = getMonthlyPrice();
  const customerId = await getPixCustomerForUser(user, cpfCnpj);
  if (!customerId) {
    return {
      provider: "asaas" as const,
      requires_cpf_cnpj: true,
      amount: price,
    };
  }

  const externalReference = `vortan:single:${user.id}`;
  const payment = await asaasRequest("/payments", {
    method: "POST",
    body: JSON.stringify({
      customer: customerId,
      billingType: "PIX",
      value: price,
      dueDate: formatAsaasDate(new Date()),
      description: "Vortan Oficina - acesso por 1 mês",
      externalReference,
    }),
  });

  if (!payment.response.ok || !payment.data?.id) {
    throw new Error(
      payment.data?.errors?.[0]?.description ??
        payment.data?.message ??
        "Não foi possível gerar a cobrança Pix",
    );
  }

  const paymentId = String(payment.data.id);
  const qr = await asaasRequest(`/payments/${encodeURIComponent(paymentId)}/pixQrCode`);
  if (!qr.response.ok || !qr.data?.payload || !qr.data?.encodedImage) {
    throw new Error(
      qr.data?.errors?.[0]?.description ??
        qr.data?.message ??
        "Não foi possível gerar o QR Code Pix",
    );
  }

  const existing = await getSubscription(user.id);
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
        billing_provider: "asaas",
        provider_customer_id: customerId,
        provider_status: "pix_pending",
        cancel_at_period_end: false,
        canceled_at: null,
      },
      { onConflict: "user_id" },
    );
  if (error) throw error;

  return {
    provider: "asaas" as const,
    requires_cpf_cnpj: false,
    payment_id: paymentId,
    amount: price,
    status: String(payment.data?.status ?? "PENDING"),
    encoded_image: String(qr.data.encodedImage),
    payload: String(qr.data.payload),
    expiration_date: qr.data?.expirationDate ? String(qr.data.expirationDate) : null,
  };
}

function asaasResourceId(value: any) {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object" && typeof value.id === "string") {
    return value.id.trim();
  }
  return "";
}

async function getAsaasCheckoutSession(checkoutId: string) {
  if (!checkoutId) return null;
  const { data, error } = await svc()
    .from("billing_checkout_sessions")
    .select("*")
    .eq("provider", "asaas")
    .eq("checkout_id", checkoutId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function getLatestAsaasCheckoutSession(
  userId: string,
  mode?: "single" | "subscription",
) {
  let query = svc()
    .from("billing_checkout_sessions")
    .select("*")
    .eq("provider", "asaas")
    .eq("user_id", userId);

  if (mode) query = query.eq("mode", mode);

  const { data, error } = await query
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function upsertAsaasCheckoutSession(params: {
  checkoutId: string;
  userId: string;
  mode: "single" | "subscription";
  status: string;
  externalReference?: string | null;
  customerId?: string | null;
  subscriptionId?: string | null;
}) {
  const current = await getAsaasCheckoutSession(params.checkoutId);
  const { error } = await svc()
    .from("billing_checkout_sessions")
    .upsert(
      {
        provider: "asaas",
        checkout_id: params.checkoutId,
        user_id: params.userId,
        mode: current?.mode ?? params.mode,
        status: params.status,
        external_reference:
          params.externalReference ?? current?.external_reference ?? null,
        customer_id: params.customerId ?? current?.customer_id ?? null,
        subscription_id:
          params.subscriptionId ?? current?.subscription_id ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "provider,checkout_id" },
    );
  if (error) throw error;
}

async function findUserBySubscriptionProviderField(
  field: "provider_customer_id" | "provider_subscription_id" | "provider_checkout_id",
  value: string,
) {
  if (!value) return null;
  const { data, error } = await svc()
    .from("subscriptions")
    .select("user_id")
    .eq(field, value)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data?.user_id ? String(data.user_id) : null;
}

async function findUserByCheckoutSessionField(
  field: "customer_id" | "subscription_id",
  value: string,
) {
  if (!value) return null;
  const { data, error } = await svc()
    .from("billing_checkout_sessions")
    .select("user_id")
    .eq("provider", "asaas")
    .eq(field, value)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data?.user_id ? String(data.user_id) : null;
}

async function resolveAsaasUserId(params: {
  externalReference?: unknown;
  checkoutId?: unknown;
  subscriptionId?: unknown;
  customerId?: unknown;
}) {
  const fromReference = extractUuid(params.externalReference);
  if (fromReference) return fromReference;

  const checkoutId = asaasResourceId(params.checkoutId);
  if (checkoutId) {
    const checkout = await getAsaasCheckoutSession(checkoutId);
    if (checkout?.user_id) return String(checkout.user_id);
    const fromSubscriptionRow = await findUserBySubscriptionProviderField(
      "provider_checkout_id",
      checkoutId,
    );
    if (fromSubscriptionRow) return fromSubscriptionRow;
  }

  const subscriptionId = asaasResourceId(params.subscriptionId);
  if (subscriptionId) {
    const fromSubscriptionRow = await findUserBySubscriptionProviderField(
      "provider_subscription_id",
      subscriptionId,
    );
    if (fromSubscriptionRow) return fromSubscriptionRow;
    const fromCheckoutRow = await findUserByCheckoutSessionField(
      "subscription_id",
      subscriptionId,
    );
    if (fromCheckoutRow) return fromCheckoutRow;
  }

  const customerId = asaasResourceId(params.customerId);
  if (customerId) {
    const fromSubscriptionRow = await findUserBySubscriptionProviderField(
      "provider_customer_id",
      customerId,
    );
    if (fromSubscriptionRow) return fromSubscriptionRow;
    const fromCheckoutRow = await findUserByCheckoutSessionField(
      "customer_id",
      customerId,
    );
    if (fromCheckoutRow) return fromCheckoutRow;

    // Fallback para clientes Asaas já existentes/migrados com externalReference.
    const customer = await getAsaasCustomer(customerId);
    const fromCustomer = extractUuid(customer?.externalReference);
    if (fromCustomer) return fromCustomer;
  }

  throw new Error("Evento Asaas sem vínculo com usuário Vortan");
}

async function listAsaasPaymentsForCheckout(checkoutId: string) {
  const query = new URLSearchParams({ checkoutSession: checkoutId, limit: "100" });
  const result = await asaasRequest(`/payments?${query.toString()}`);
  if (!result.response.ok) {
    throw new Error(
      result.data?.errors?.[0]?.description ??
        result.data?.message ??
        "Erro ao conciliar cobranças do Checkout Asaas",
    );
  }
  return Array.isArray(result.data?.data) ? result.data.data : [];
}

function chooseAsaasCheckoutPayment(payments: any[]) {
  const expected = getMonthlyPrice();
  const matching = payments.filter(
    (payment: any) => Math.abs(Number(payment?.value) - expected) < 0.009,
  );
  return (
    matching.find((payment: any) =>
      ["CONFIRMED", "RECEIVED"].includes(String(payment?.status ?? "").toUpperCase()),
    ) ?? matching[0] ?? null
  );
}

async function reconcileAsaasCheckout(checkout: any, event: string) {
  const checkoutId = asaasResourceId(checkout?.id);
  if (!checkoutId) throw new Error("Webhook Asaas sem ID do Checkout");

  const stored = await getAsaasCheckoutSession(checkoutId);
  const userId =
    (stored?.user_id ? String(stored.user_id) : null) ??
    extractUuid(checkout?.externalReference);
  if (!userId) throw new Error("Checkout Asaas sem vínculo com usuário Vortan");

  const mode: "single" | "subscription" =
    stored?.mode === "subscription" ||
      (Array.isArray(checkout?.chargeTypes) && checkout.chargeTypes.includes("RECURRENT"))
      ? "subscription"
      : "single";

  let customerId = asaasResourceId(checkout?.customer) || String(stored?.customer_id ?? "");
  let subscriptionId = String(stored?.subscription_id ?? "");
  let payment: any = null;

  if (event === "CHECKOUT_PAID" || !customerId || (mode === "subscription" && !subscriptionId)) {
    const payments = await listAsaasPaymentsForCheckout(checkoutId);
    payment = chooseAsaasCheckoutPayment(payments);
    customerId = asaasResourceId(payment?.customer) || customerId;
    subscriptionId = asaasResourceId(payment?.subscription) || subscriptionId;
  }

  await upsertAsaasCheckoutSession({
    checkoutId,
    userId,
    mode,
    status: event,
    externalReference: checkout?.externalReference
      ? String(checkout.externalReference)
      : stored?.external_reference ?? null,
    customerId: customerId || null,
    subscriptionId: subscriptionId || null,
  });

  const patch: Record<string, unknown> = {
    billing_provider: "asaas",
    provider_checkout_id: checkoutId,
    provider_status: event,
  };
  if (customerId) patch.provider_customer_id = customerId;
  if (subscriptionId) patch.provider_subscription_id = subscriptionId;

  const { error } = await svc()
    .from("subscriptions")
    .update(patch)
    .eq("user_id", userId);
  if (error) throw error;

  return { userId, mode, customerId, subscriptionId, payment };
}

async function wasAsaasPaymentProcessed(paymentId: string) {
  const { data, error } = await svc()
    .from("billing_webhook_events")
    .select("id")
    .eq("provider", "asaas")
    .eq("resource_id", paymentId)
    .in("topic", ["PAYMENT_CONFIRMED", "PAYMENT_RECEIVED"])
    .eq("status", "processed")
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
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
  provider: string;
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
      provider: params.provider,
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
    .eq("provider", params.provider)
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

async function processAsaasPayment(payment: any, event: string) {
  const paymentId = String(payment?.id ?? "").trim();
  if (!paymentId) throw new Error("Webhook Asaas sem ID da cobrança");

  if (await wasAsaasPaymentProcessed(paymentId)) {
    return { ok: true, duplicate: true };
  }

  const expectedAmount = getMonthlyPrice();
  const receivedAmount = Number(payment?.value);
  if (!Number.isFinite(receivedAmount) || Math.abs(receivedAmount - expectedAmount) > 0.009) {
    throw new Error("Valor do pagamento Asaas inválido");
  }

  const checkoutId = asaasResourceId(payment?.checkoutSession);
  const subscriptionId = asaasResourceId(payment?.subscription);
  const customerId = asaasResourceId(payment?.customer);
  const userId = await resolveAsaasUserId({
    externalReference: payment?.externalReference,
    checkoutId,
    subscriptionId,
    customerId,
  });

  const existing = await getSubscription(userId);
  if (String(existing?.last_payment_id ?? "") === paymentId) {
    return { ok: true, duplicate: true };
  }

  const paidAtRaw =
    payment?.confirmedDate ?? payment?.paymentDate ?? payment?.clientPaymentDate ?? payment?.dueDate;
  const paidAt = paidAtRaw ? new Date(paidAtRaw) : new Date();
  const safePaidAt = Number.isNaN(paidAt.getTime()) ? new Date() : paidAt;
  const existingExpiration = existing?.expires_at ? new Date(existing.expires_at) : null;
  const baseDate =
    existingExpiration &&
      !Number.isNaN(existingExpiration.getTime()) &&
      existingExpiration.getTime() > safePaidAt.getTime()
      ? existingExpiration
      : safePaidAt;
  const expiresAt = addMonths(baseDate, 1);

  const subscriptionPatch: Record<string, unknown> = {
    billing_provider: "asaas",
    provider_customer_id: customerId || existing?.provider_customer_id || null,
    provider_status: String(payment?.status ?? event),
    last_payment_id: paymentId,
    last_payment_at: safePaidAt.toISOString(),
    cancel_at_period_end: false,
    canceled_at: null,
  };
  if (subscriptionId) subscriptionPatch.provider_subscription_id = subscriptionId;
  if (checkoutId) subscriptionPatch.provider_checkout_id = checkoutId;

  await syncAccessState({
    userId,
    status: "active",
    expiresAt,
    subscriptionPatch,
  });

  if (checkoutId) {
    const storedCheckout = await getAsaasCheckoutSession(checkoutId);
    await upsertAsaasCheckoutSession({
      checkoutId,
      userId,
      mode:
        storedCheckout?.mode === "subscription" || subscriptionId
          ? "subscription"
          : "single",
      status: event,
      externalReference: storedCheckout?.external_reference ?? null,
      customerId: customerId || null,
      subscriptionId: subscriptionId || null,
    });
  }

  return { ok: true, expires_at: expiresAt.toISOString() };
}

async function processAsaasSubscription(subscription: any, event: string) {
  const subscriptionId = String(subscription?.id ?? "").trim();
  if (!subscriptionId) throw new Error("Webhook Asaas sem ID da assinatura");

  const customerId = asaasResourceId(subscription?.customer);
  const userId = await resolveAsaasUserId({
    externalReference: subscription?.externalReference,
    subscriptionId,
    customerId,
  });
  const current = await getSubscription(userId);
  const currentExpiration = current?.expires_at ? new Date(current.expires_at) : new Date();
  const safeExpiration = Number.isNaN(currentExpiration.getTime()) ? new Date() : currentExpiration;
  const stillHasAccess = isSubscriptionActive(current);
  const isEnding = ["SUBSCRIPTION_INACTIVATED", "SUBSCRIPTION_DELETED"].includes(event);

  const patch: Record<string, unknown> = {
    billing_provider: "asaas",
    provider_customer_id: customerId || current?.provider_customer_id || null,
    provider_subscription_id: subscriptionId,
    provider_status: String(subscription?.status ?? event),
    cancel_at_period_end: isEnding,
    canceled_at: isEnding ? new Date().toISOString() : null,
  };

  if (isEnding && !stillHasAccess) {
    await syncAccessState({
      userId,
      status: "canceled",
      expiresAt: safeExpiration,
      subscriptionPatch: patch,
    });
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
          ...patch,
        },
        { onConflict: "user_id" },
      );
    if (error) throw error;
  }

  return { ok: true, provider_status: patch.provider_status };
}

async function processAsaasPaymentIssue(payment: any, event: string) {
  const userId = await resolveAsaasUserId({
    externalReference: payment?.externalReference,
    checkoutId: payment?.checkoutSession,
    subscriptionId: payment?.subscription,
    customerId: payment?.customer,
  });
  const current = await getSubscription(userId);
  if (!current) return { ok: true, ignored: true };

  const patch: Record<string, unknown> = {
    billing_provider: "asaas",
    provider_status: event,
  };
  const customerId = asaasResourceId(payment?.customer);
  const subscriptionId = asaasResourceId(payment?.subscription);
  const checkoutId = asaasResourceId(payment?.checkoutSession);
  if (customerId) patch.provider_customer_id = customerId;
  if (subscriptionId) patch.provider_subscription_id = subscriptionId;
  if (checkoutId) patch.provider_checkout_id = checkoutId;

  const isLatestPayment = String(current?.last_payment_id ?? "") === String(payment?.id ?? "");
  if (event === "PAYMENT_REFUNDED" && isLatestPayment) {
    await syncAccessState({
      userId,
      status: "expired",
      expiresAt: new Date(),
      subscriptionPatch: patch,
    });
    return { ok: true, access_revoked: true };
  }

  const expiration = current.expires_at ? new Date(current.expires_at) : new Date(0);
  if (
    ["PAYMENT_OVERDUE", "PAYMENT_CREDIT_CARD_CAPTURE_REFUSED"].includes(event) &&
    !Number.isNaN(expiration.getTime()) &&
    expiration.getTime() <= Date.now()
  ) {
    await syncAccessState({
      userId,
      status: "expired",
      expiresAt: expiration,
      subscriptionPatch: patch,
    });
    return { ok: true, expired: true };
  }

  const { error } = await svc()
    .from("subscriptions")
    .update(patch)
    .eq("user_id", userId);
  if (error) throw error;
  return { ok: true, updated: true };
}

async function processAsaasCheckout(checkout: any, event: string) {
  const reconciled = await reconcileAsaasCheckout(checkout, event);

  if (event === "CHECKOUT_PAID" && reconciled.payment) {
    const status = String(reconciled.payment?.status ?? "").toUpperCase();
    if (["CONFIRMED", "RECEIVED"].includes(status)) {
      return await processAsaasPayment(reconciled.payment, event);
    }
  }

  return {
    ok: true,
    checkout_id: asaasResourceId(checkout?.id),
    status: event,
    reconciled: true,
  };
}


// ─── Billing (Asaas) ────────────────────────────────────────────────────────

async function createAsaasCheckout(user: any, mode: "single" | "subscription") {
  if (!user.email) throw new Error("Usuário sem e-mail válido");

  const price = getMonthlyPrice();
  const appUrl = getAppBaseUrl();
  const recurring = mode === "subscription";
  const externalReference = `vortan:${recurring ? "recurring" : "single"}:${user.id}`;
  const existing = await getSubscription(user.id);
  const latestCheckout = await getLatestAsaasCheckoutSession(user.id);

  // No primeiro Checkout a Vortan não envia customer/customerData porque não
  // armazena CPF/CNPJ. Depois que o Asaas cria/associa o cliente, reutilizamos
  // o ID nas próximas compras para evitar cadastro duplicado. O GET também
  // impede reutilizar por engano um ID do Sandbox depois da troca para Produção.
  const candidateCustomerId =
    (String(existing?.billing_provider ?? "") === "asaas"
      ? String(existing?.provider_customer_id ?? "").trim()
      : "") || String(latestCheckout?.customer_id ?? "").trim();
  let knownCustomerId = "";
  if (candidateCustomerId) {
    const customer = await getAsaasCustomer(candidateCustomerId);
    if (customer?.id) knownCustomerId = candidateCustomerId;
  }

  const payload: Record<string, unknown> = {
    billingTypes: ["CREDIT_CARD"],
    chargeTypes: recurring ? ["RECURRENT"] : ["DETACHED"],
    minutesToExpire: 60,
    externalReference,
    callback: {
      successUrl: `${appUrl}?billing=success`,
      cancelUrl: `${appUrl}?billing=canceled`,
      expiredUrl: `${appUrl}?billing=expired`,
    },
    items: [
      {
        name: recurring ? "Plano Fundadores" : "Vortan Oficina - 1 mês",
        description: recurring
          ? "Assinatura mensal Vortan Oficina"
          : "Acesso Vortan Oficina por 1 mês",
        quantity: 1,
        value: price,
      },
    ],
  };

  if (knownCustomerId) payload.customer = knownCustomerId;

  if (recurring) {
    payload.subscription = {
      cycle: "MONTHLY",
      nextDueDate: formatAsaasDateTime(new Date()),
    };
  }

  const created = await asaasRequest("/checkouts", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  if (!created.response.ok || !created.data?.id) {
    const description =
      created.data?.errors?.[0]?.description ??
      created.data?.message ??
      "Erro ao criar checkout no Asaas";
    throw new Error(description);
  }

  const checkoutId = String(created.data.id);
  await upsertAsaasCheckoutSession({
    checkoutId,
    userId: user.id,
    mode,
    status: "created",
    externalReference,
    customerId: knownCustomerId || null,
  });

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
        billing_provider: "asaas",
        provider_customer_id: knownCustomerId || null,
        ...(recurring ? { provider_subscription_id: null } : {}),
        provider_checkout_id: checkoutId,
        provider_status: recurring ? "checkout_recurring_created" : "checkout_single_created",
        cancel_at_period_end: false,
        canceled_at: null,
      },
      { onConflict: "user_id" },
    );
  if (error) throw error;

  const returnedCheckoutUrl =
    created.data?.url ??
    created.data?.checkoutUrl ??
    created.data?.checkout_url ??
    created.data?.paymentUrl ??
    created.data?.payment_url;

  return {
    id: checkoutId,
    checkout_url: asaasCheckoutUrl(checkoutId, returnedCheckoutUrl),
    provider: "asaas" as const,
  };
}

app.post(`${P}/billing/pix/create`, async (c) => {
  try {
    const user = await getUser(c.req.header("Authorization"));
    if (!user) return unauthorized(c);

    const parsed = await readJsonObject(c, 8 * 1024);
    if (parsed.response) return parsed.response;
    const cpfCnpj = parsed.body?.cpfCnpj;
    if (cpfCnpj !== undefined && typeof cpfCnpj !== "string") {
      return badRequest(c, "CPF/CNPJ inválido");
    }

    return c.json(await createAsaasPixPayment(user, cpfCnpj));
  } catch (error: any) {
    return serverError(c, error, "Não foi possível gerar o Pix");
  }
});

app.post(`${P}/billing/create-checkout`, async (c) => {
  try {
    const user = await getUser(c.req.header("Authorization"));
    if (!user) return unauthorized(c);
    return c.json(await createAsaasCheckout(user, "single"));
  } catch (error: any) {
    return serverError(c, error, "Não foi possível criar o pagamento");
  }
});

app.post(`${P}/billing/create-subscription`, async (c) => {
  try {
    const user = await getUser(c.req.header("Authorization"));
    if (!user) return unauthorized(c);
    return c.json(await createAsaasCheckout(user, "subscription"));
  } catch (error: any) {
    return serverError(c, error, "Não foi possível criar a assinatura");
  }
});

app.post(`${P}/billing/webhook`, async (c) => {
  let claimedEventId: string | null = null;

  try {
    const expectedToken = Deno.env.get("ASAAS_WEBHOOK_TOKEN") ?? "";
    if (!expectedToken) throw new Error("ASAAS_WEBHOOK_TOKEN não configurado");
    const receivedToken = c.req.header("asaas-access-token") ?? "";
    if (!timingSafeEqualString(receivedToken, expectedToken)) {
      return c.json({ ok: false, error: "Webhook Asaas não autorizado" }, 401);
    }

    const parsed = await readJsonObject(c, 256 * 1024);
    if (parsed.response) return parsed.response;
    const body = parsed.body;
    const event = String(body?.event ?? "").trim();
    const resourceId = String(
      body?.payment?.id ?? body?.subscription?.id ?? body?.checkout?.id ?? body?.id ?? "",
    ).trim();
    if (!event || !resourceId) return badRequest(c, "Webhook Asaas inválido");

    const claim = await claimWebhookEvent({
      provider: "asaas",
      topic: event,
      resourceId,
      notificationId: String(body?.id ?? ""),
      action: event,
      createdAt: String(body?.dateCreated ?? ""),
      requestId: "",
      payload: body,
    });
    claimedEventId = claim.id;
    if (claim.duplicate) return c.json({ ok: true, duplicate: true });

    let result: Record<string, unknown> = { ok: true, ignored: true, event };

    if (["PAYMENT_CONFIRMED", "PAYMENT_RECEIVED"].includes(event)) {
      result = await processAsaasPayment(body?.payment, event);
    } else if (
      [
        "PAYMENT_OVERDUE",
        "PAYMENT_CREDIT_CARD_CAPTURE_REFUSED",
        "PAYMENT_REFUNDED",
        "PAYMENT_CHARGEBACK_REQUESTED",
        "PAYMENT_CHARGEBACK_DISPUTE",
      ].includes(event)
    ) {
      result = await processAsaasPaymentIssue(body?.payment, event);
    } else if (
      [
        "SUBSCRIPTION_CREATED",
        "SUBSCRIPTION_UPDATED",
        "SUBSCRIPTION_INACTIVATED",
        "SUBSCRIPTION_DELETED",
      ].includes(event)
    ) {
      result = await processAsaasSubscription(body?.subscription, event);
    } else if (
      ["CHECKOUT_CREATED", "CHECKOUT_PAID", "CHECKOUT_CANCELED", "CHECKOUT_EXPIRED"].includes(
        event,
      )
    ) {
      result = await processAsaasCheckout(body?.checkout, event);
    }

    await finishWebhookEvent(claimedEventId);
    return c.json(result);
  } catch (error: any) {
    const errorMessage = error?.message ?? "Erro ao processar webhook Asaas";
    if (claimedEventId) await failWebhookEvent(claimedEventId, errorMessage);
    console.error("Erro no webhook Asaas:", error);
    return c.json({ ok: false, error: "Erro ao processar webhook Asaas" }, 500);
  }
});

app.post(`${P}/billing/cancel-subscription`, async (c) => {
  try {
    const user = await getUser(c.req.header("Authorization"));
    if (!user) return unauthorized(c);

    const sub = await getSubscription(user.id);
    if (sub?.billing_provider === "asaas" && sub?.cancel_at_period_end === true) {
      return c.json({
        ok: true,
        message: "Assinatura já cancelada. O acesso permanece até o fim do período pago.",
        expires_at: sub?.expires_at ?? null,
      });
    }

    let subscriptionId = String(sub?.provider_subscription_id ?? "").trim();
    let customerId = String(sub?.provider_customer_id ?? "").trim();
    let checkoutId = String(sub?.provider_checkout_id ?? "").trim();

    const latestCheckout = await getLatestAsaasCheckoutSession(user.id, "subscription");
    checkoutId = checkoutId || String(latestCheckout?.checkout_id ?? "").trim();
    customerId = customerId || String(latestCheckout?.customer_id ?? "").trim();
    subscriptionId = subscriptionId || String(latestCheckout?.subscription_id ?? "").trim();

    if (checkoutId && (!customerId || !subscriptionId)) {
      const payments = await listAsaasPaymentsForCheckout(checkoutId);
      const payment = chooseAsaasCheckoutPayment(payments);
      customerId = asaasResourceId(payment?.customer) || customerId;
      subscriptionId = asaasResourceId(payment?.subscription) || subscriptionId;

      if (payment) {
        await upsertAsaasCheckoutSession({
          checkoutId,
          userId: user.id,
          mode: "subscription",
          status: "reconciled_for_cancel",
          externalReference: latestCheckout?.external_reference ?? null,
          customerId: customerId || null,
          subscriptionId: subscriptionId || null,
        });
      }
    }

    if (!subscriptionId) {
      return c.json({ error: "Assinatura recorrente não encontrada." }, 404);
    }

    const canceled = await asaasRequest(`/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      method: "DELETE",
    });
    if (!canceled.response.ok) {
      return c.json(
        {
          error:
            canceled.data?.errors?.[0]?.description ??
            canceled.data?.message ??
            "Erro ao cancelar assinatura no Asaas.",
        },
        502,
      );
    }

    const expiresAt = sub?.expires_at ? new Date(sub.expires_at) : new Date();
    const safeExpiration = Number.isNaN(expiresAt.getTime()) ? new Date() : expiresAt;
    const stillHasAccess =
      safeExpiration.getTime() > Date.now() &&
      ["active", "trial"].includes(String(sub?.status ?? ""));

    if (stillHasAccess) {
      const { error } = await svc()
        .from("subscriptions")
        .update({
          billing_provider: "asaas",
          provider_customer_id: customerId || sub?.provider_customer_id || null,
          provider_subscription_id: subscriptionId,
          provider_status: "DELETED",
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
          billing_provider: "asaas",
          provider_customer_id: customerId || sub?.provider_customer_id || null,
          provider_subscription_id: subscriptionId,
          provider_status: "DELETED",
          cancel_at_period_end: true,
          canceled_at: new Date().toISOString(),
        },
      });
    }

    if (checkoutId) {
      await upsertAsaasCheckoutSession({
        checkoutId,
        userId: user.id,
        mode: "subscription",
        status: "subscription_deleted",
        externalReference: latestCheckout?.external_reference ?? null,
        customerId: customerId || null,
        subscriptionId,
      });
    }

    return c.json({
      ok: true,
      message: stillHasAccess
        ? "Assinatura cancelada. Você continuará com acesso até o fim do período pago."
        : "Assinatura cancelada.",
      expires_at: sub?.expires_at ?? null,
    });
  } catch (error: any) {
    return serverError(c, error, "Erro interno ao cancelar assinatura");
  }
});

Deno.serve(app.fetch);
