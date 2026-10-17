import { Hono } from "npm:hono";
import { cors } from "npm:hono/cors";
import { logger } from "npm:hono/logger";
import { createClient } from "jsr:@supabase/supabase-js@2";

const app = new Hono();
const P = "/rapid-action";

app.use("*", logger());

const allowedOrigins = [
  "http://localhost:5173",
  "https://autoflowoficina.online",
  "https://www.autoflowoficina.online",
  "https://vortanoficina.com.br",
  "https://www.vortanoficina.com.br",
  "https://autoflow-saas-two.vercel.app",
];

app.use(
  "*",
  cors({
    origin: (origin) => {
      if (allowedOrigins.includes(origin)) {
        return origin;
      }

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
const serverError = (c: any, msg: string) => c.json({ error: msg }, 500);

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
    return c.json({ error: profileError.message }, 500);
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
    return { user: null, response: serverError(c, error.message) };
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
  if (firstError) return serverError(c, firstError.message);

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
  const body = await c.req.json().catch(() => ({}));
  const action = String(body?.action ?? "");

  if (!isUuid(targetId)) return badRequest(c, "Oficina inválida");

  const { data: targetProfile, error: targetError } = await svc()
    .from("af_profiles")
    .select("id, is_admin")
    .eq("id", targetId)
    .maybeSingle();

  if (targetError) return serverError(c, targetError.message);
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

  if (error) return serverError(c, error.message);
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
  if (error) return serverError(c, error.message);
  return c.json(data);
});

app.post(`${P}/profile`, async (c) => {
  const user = await getUser(c.req.header("Authorization"));
  if (!user) return unauthorized(c);

  const body = await c.req.json();

  if (!body.workshop_name?.trim()) {
    return badRequest(c, "Nome da oficina é obrigatório");
  }

  const { error } = await svc()
    .from("af_profiles")
    .upsert({
      id: user.id,
      workshop_name: body.workshop_name?.trim() ?? "",
      owner_name: body.owner_name?.trim() ?? "",
      phone: body.phone ?? "",
      whatsapp: body.whatsapp ?? "",
      instagram: body.instagram ?? "",
      address: body.address ?? "",
      city: body.city ?? "",
      state: body.state ?? "",
      logo_url: body.logo_url ?? "",
    });

  if (error) return serverError(c, error.message);

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

  if (profileError) return serverError(c, profileError.message);

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
  if (error) return serverError(c, error.message);
  return c.json(data ?? []);
});

app.post(`${P}/clients`, async (c) => {
  const user = await getUser(c.req.header("Authorization"));
  if (!user) return unauthorized(c);

  const blocked = await requireActiveSubscription(c, user);
  if (blocked) return blocked;
  const body = await c.req.json();
  if (!body.name?.trim()) return badRequest(c, "Nome é obrigatório");
  const { data, error } = await svc()
    .from("af_clients")
    .insert({
      workshop_id: user.id,
      name: body.name.trim(),
      phone: body.phone ?? "",
      whatsapp: body.whatsapp ?? "",
    })
    .select()
    .single();
  if (error) return serverError(c, error.message);
  return c.json(data, 201);
});

app.put(`${P}/clients/:id`, async (c) => {
  const user = await getUser(c.req.header("Authorization"));
  if (!user) return unauthorized(c);

  const blocked = await requireActiveSubscription(c, user);
  if (blocked) return blocked;
  const id = c.req.param("id");
  const body = await c.req.json();
  if (!body.name?.trim()) return badRequest(c, "Nome é obrigatório");
  const { data, error } = await svc()
    .from("af_clients")
    .update({
      name: body.name.trim(),
      phone: body.phone ?? "",
      whatsapp: body.whatsapp ?? "",
    })
    .eq("id", id)
    .eq("workshop_id", user.id)
    .select()
    .single();
  if (error) return serverError(c, error.message);
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

  if (error) return serverError(c, error.message);
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
  const { error } = await svc()
    .from("af_clients")
    .delete()
    .eq("id", id)
    .eq("workshop_id", user.id);
  if (error) return serverError(c, error.message);
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
  if (error) return serverError(c, error.message);
  return c.json(data ?? []);
});

app.post(`${P}/vehicles`, async (c) => {
  const user = await getUser(c.req.header("Authorization"));
  if (!user) return unauthorized(c);

  const blocked = await requireActiveSubscription(c, user);
  if (blocked) return blocked;
  const body = await c.req.json();
  if (!body.plate?.trim()) return badRequest(c, "Placa é obrigatória");
  if (!body.client_id) return badRequest(c, "Cliente é obrigatório");
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
  if (error) return serverError(c, error.message);
  return c.json(data, 201);
});

app.put(`${P}/vehicles/:id`, async (c) => {
  const user = await getUser(c.req.header("Authorization"));
  if (!user) return unauthorized(c);

  const blocked = await requireActiveSubscription(c, user);
  if (blocked) return blocked;
  const id = c.req.param("id");
  const body = await c.req.json();
  if (!body.plate?.trim()) return badRequest(c, "Placa é obrigatória");
  if (!body.client_id) return badRequest(c, "Cliente é obrigatório");

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
      plate: body.plate.trim().toUpperCase(),
      brand: body.brand ?? "",
      model: body.model ?? "",
      year: body.year ?? "",
      mileage: body.mileage ?? "",
    })
    .eq("id", id)
    .eq("workshop_id", user.id)
    .select()
    .single();
  if (error) return serverError(c, error.message);
  if (!data) return c.json({ error: "Not found" }, 404);
  return c.json(data);
});

app.delete(`${P}/vehicles/:id`, async (c) => {
  const user = await getUser(c.req.header("Authorization"));
  if (!user) return unauthorized(c);

  const blocked = await requireActiveSubscription(c, user);
  if (blocked) return blocked;
  const id = c.req.param("id");
  const { error } = await svc()
    .from("af_vehicles")
    .delete()
    .eq("id", id)
    .eq("workshop_id", user.id);
  if (error) return serverError(c, error.message);
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

  if (error) return serverError(c, error.message);

  return c.json(data ?? []);
});

app.post(`${P}/financial`, async (c) => {
  const user = await getUser(c.req.header("Authorization"));
  if (!user) return unauthorized(c);

  const blocked = await requireActiveSubscription(c, user);
  if (blocked) return blocked;

  const body = await c.req.json();

  const { data, error } = await svc()
    .from("af_financial_entries")
    .insert({
      workshop_id: user.id,
      description: body.description,
      amount: body.amount,
      type: body.type,
      category: body.category ?? "",
    })
    .select()
    .single();

  if (error) return serverError(c, error.message);

  return c.json(data);
});

app.delete(`${P}/financial/:id`, async (c) => {
  const user = await getUser(c.req.header("Authorization"));
  if (!user) return unauthorized(c);

  const blocked = await requireActiveSubscription(c, user);
  if (blocked) return blocked;

  const id = c.req.param("id");

  const { error } = await svc()
    .from("af_financial_entries")
    .delete()
    .eq("id", id)
    .eq("workshop_id", user.id);

  if (error) return serverError(c, error.message);

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
  if (error) return serverError(c, error.message);
  return c.json(data ?? []);
});

app.post(`${P}/orders`, async (c) => {
  const user = await getUser(c.req.header("Authorization"));
  if (!user) return unauthorized(c);

  const blocked = await requireActiveSubscription(c, user);
  if (blocked) return blocked;
  const body = await c.req.json();
  if (!body.client_id) return badRequest(c, "Cliente é obrigatório");
  if (!body.vehicle_id) return badRequest(c, "Veículo é obrigatório");
  if (!body.reported_issue?.trim())
    return badRequest(c, "Problema relatado é obrigatório");
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
    reported_issue: body.reported_issue.trim(),
    employee_name: body.employee_name?.trim() ?? "",
    services_performed: body.services_performed ?? "",
    value: body.value ?? "0",
    status: body.status ?? "aguardando",
    notes: body.notes ?? "",
    created_at: now,
    updated_at: now,
  };

  if (body.delivery_date) orderInsert.delivery_date = body.delivery_date;
  if (body.checklist) orderInsert.checklist = body.checklist;

  const { data, error } = await svc()
    .from("af_service_orders")
    .insert(orderInsert)
    .select()
    .single();
  if (error) return serverError(c, error.message);
  return c.json(data, 201);
});

app.put(`${P}/orders/:id`, async (c) => {
  const user = await getUser(c.req.header("Authorization"));
  if (!user) return unauthorized(c);

  const blocked = await requireActiveSubscription(c, user);
  if (blocked) return blocked;
  const id = c.req.param("id");
  const body = await c.req.json();
  const allowed = [
    "reported_issue",
    "employee_name",
    "services_performed",
    "value",
    "status",
    "notes",
    "delivery_date",
    "checklist",
  ];
  const patch: Record<string, any> = { updated_at: new Date().toISOString() };
  for (const key of allowed) {
    if (body[key] !== undefined) patch[key] = body[key];
  }

  if (
    patch.status &&
    !["aguardando", "em_manutencao", "finalizado"].includes(patch.status)
  ) {
    return badRequest(c, "Status inválido");
  }

  const { data, error } = await svc()
    .from("af_service_orders")
    .update(patch)
    .eq("id", id)
    .eq("workshop_id", user.id)
    .select()
    .single();
  if (error) return serverError(c, error.message);
  if (!data) return c.json({ error: "Not found" }, 404);
  return c.json(data);
});

app.delete(`${P}/orders/:id`, async (c) => {
  const user = await getUser(c.req.header("Authorization"));
  if (!user) return unauthorized(c);

  const blocked = await requireActiveSubscription(c, user);
  if (blocked) return blocked;
  const id = c.req.param("id");
  const { error } = await svc()
    .from("af_service_orders")
    .delete()
    .eq("id", id)
    .eq("workshop_id", user.id);
  if (error) return serverError(c, error.message);

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
    billingTypes: recurring ? ["CREDIT_CARD"] : ["PIX", "CREDIT_CARD"],
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

app.post(`${P}/billing/create-checkout`, async (c) => {
  try {
    const user = await getUser(c.req.header("Authorization"));
    if (!user) return unauthorized(c);
    return c.json(await createAsaasCheckout(user, "single"));
  } catch (error: any) {
    console.error("Erro ao criar checkout Asaas:", error);
    return serverError(c, error?.message ?? "Erro ao criar pagamento");
  }
});

app.post(`${P}/billing/create-subscription`, async (c) => {
  try {
    const user = await getUser(c.req.header("Authorization"));
    if (!user) return unauthorized(c);
    return c.json(await createAsaasCheckout(user, "subscription"));
  } catch (error: any) {
    console.error("Erro ao criar assinatura Asaas:", error);
    return serverError(c, error?.message ?? "Erro ao criar assinatura");
  }
});

app.post(`${P}/billing/webhook`, async (c) => {
  let claimedEventId: string | null = null;

  try {
    const expectedToken = Deno.env.get("ASAAS_WEBHOOK_TOKEN") ?? "";
    if (!expectedToken) throw new Error("ASAAS_WEBHOOK_TOKEN não configurado");
    const receivedToken = c.req.header("asaas-access-token") ?? "";
    if (receivedToken !== expectedToken) {
      return c.json({ ok: false, error: "Webhook Asaas não autorizado" }, 401);
    }

    const body = await c.req.json().catch(() => ({}));
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
    return c.json({ ok: false, error: errorMessage }, 500);
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
    console.error("Erro ao cancelar assinatura Asaas:", error);
    return serverError(c, error?.message ?? "Erro interno ao cancelar assinatura");
  }
});

Deno.serve(app.fetch);
