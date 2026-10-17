import { useState, useEffect, useCallback } from "react";
import type { User, Session } from "@supabase/supabase-js";
import {
  LayoutDashboard,
  Users,
  Car,
  ClipboardList,
  History,
  LogOut,
  Plus,
  Search,
  MessageCircle,
  ChevronRight,
  X,
  Edit2,
  Trash2,
  Wrench,
  CheckCircle,
  Clock,
  AlertCircle,
  Menu,
  ArrowLeft,
  Phone,
  Calendar,
  Gauge,
  DollarSign,
  FileText,
  Eye,
  RefreshCw,
  Building2,
  Download,
  Upload,
  Image as ImageIcon,
  Send,
  TrendingUp,
  Shield,
  Target,
  BarChart3,
  TrendingDown,
} from "lucide-react";
import { supabase } from "../lib/supabase";
import * as API from "../lib/api";
import type {
  Profile,
  Client,
  Vehicle,
  ServiceOrder,
  OrderStatus,
  FinancialEntry,
} from "../lib/api";
import jsPDF from "jspdf";
import { useLocation, useNavigate } from "react-router-dom";
import AdminPage from "../pages/AdminPage";
import { generateBudgetPDF, generateOrderPDF } from "../Utils/pdfGenerator";

// ─── Types ────────────────────────────────────────────────────────────────────

type Page =
  | "billing"
  | "dashboard"
  | "clients"
  | "vehicles"
  | "budgets"
  | "orders"
  | "history"
  | "order-detail"
  | "settings"
  | "financial"
  | "admin";

// ─── Status helpers ───────────────────────────────────────────────────────────

const STATUS_LABEL: Record<OrderStatus, string> = {
  aguardando: "Aguardando",
  em_manutencao: "Em Manutenção",
  finalizado: "Finalizado",
};

const STATUS_COLOR: Record<OrderStatus, string> = {
  aguardando: "text-amber-400 bg-amber-400/10 border-amber-400/20",
  em_manutencao: "text-blue-400 bg-blue-400/10 border-blue-400/20",
  finalizado: "text-emerald-400 bg-emerald-400/10 border-emerald-400/20",
};

function StatusBadge({ status }: { status: OrderStatus }) {
  const icons = {
    aguardando: <Clock size={11} />,
    em_manutencao: <Wrench size={11} />,
    finalizado: <CheckCircle size={11} />,
  };
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-xs font-mono font-medium ${STATUS_COLOR[status]}`}
    >
      {icons[status]}
      {STATUS_LABEL[status]}
    </span>
  );
}

const BUDGET_NOTE_MARKER = "[VORTAN_ORCAMENTO]";
const BUDGET_NOTE_END_MARKER = "[FIM_VORTAN_ORCAMENTO]";

type BudgetItem = {
  description: string;
  value: string;
};

type BudgetDetails = {
  payment_method?: string;
  payment_details?: string;
  validity?: string;
  client_note?: string;
  internal_note?: string;
  parts?: BudgetItem[];
  labor?: BudgetItem[];
};

function isBudgetOrder(order: ServiceOrder) {
  return String(order.notes || "").includes(BUDGET_NOTE_MARKER);
}

function buildBudgetNotes(details: BudgetDetails) {
  return [
    BUDGET_NOTE_MARKER,
    `payment_method=${details.payment_method || ""}`,
    `payment_details=${details.payment_details || ""}`,
    `validity=${details.validity || ""}`,
    `client_note=${String(details.client_note || "").replace(/\n/g, "\\n")}`,
    `internal_note=${String(details.internal_note || "").replace(/\n/g, "\\n")}`,
    `parts=${encodeURIComponent(JSON.stringify(details.parts || []))}`,
    `labor=${encodeURIComponent(JSON.stringify(details.labor || []))}`,
    BUDGET_NOTE_END_MARKER,
  ].join("\n");
}

function getBudgetDetails(notes?: string | null): BudgetDetails {
  const text = String(notes || "");
  const details: BudgetDetails = {};

  const start = text.indexOf(BUDGET_NOTE_MARKER);
  const end = text.indexOf(BUDGET_NOTE_END_MARKER);
  if (start === -1) return details;

  const block = text.slice(start, end === -1 ? undefined : end).split("\n");
  for (const line of block) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim() as keyof BudgetDetails;
    const value = line
      .slice(eq + 1)
      .replace(/\\n/g, "\n")
      .trim();
    if (key === "parts" || key === "labor") {
      try {
        (details as any)[key] = JSON.parse(decodeURIComponent(value || "[]"));
      } catch {
        (details as any)[key] = [];
      }
    } else {
      (details as any)[key] = value;
    }
  }

  return details;
}

function cleanBudgetNotes(notes?: string | null) {
  const text = String(notes || "");
  const start = text.indexOf(BUDGET_NOTE_MARKER);
  if (start === -1) return text.trim();

  const end = text.indexOf(BUDGET_NOTE_END_MARKER);
  if (end === -1) return text.replace(BUDGET_NOTE_MARKER, "").trim();

  return `${text.slice(0, start)}${text.slice(end + BUDGET_NOTE_END_MARKER.length)}`.trim();
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function fmt(date: string) {
  return new Date(date).toLocaleDateString("pt-BR");
}

function fmtMoney(v?: string | number) {
  const n =
    typeof v === "number" ? v : Number(String(v || "0").replace(",", "."));

  return n.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function cleanFileName(name: string) {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase();
}

function csvEscape(value: unknown) {
  const text = String(value ?? "").replace(/\r?\n|\r/g, " ");
  return `"${text.replace(/"/g, '""')}"`;
}

function downloadCSV(filename: string, rows: Array<Record<string, unknown>>) {
  if (!rows.length) {
    const blob = new Blob([""], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    return;
  }

  const headers = Object.keys(rows[0]);
  const csv = [
    headers.map(csvEscape).join(";"),
    ...rows.map((row) => headers.map((h) => csvEscape(row[h])).join(";")),
  ].join("\n");

  const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── UI Primitives ────────────────────────────────────────────────────────────

function Input({
  label,
  error,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  error?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          {label}
        </label>
      )}
      <input
        {...props}
        className={`w-full bg-input-background border rounded-md px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-colors ${error ? "border-destructive" : "border-border"} ${props.className ?? ""}`}
      />
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}

function Select({
  label,
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & { label?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          {label}
        </label>
      )}
      <select
        {...props}
        className="w-full bg-input-background border border-border rounded-md px-3 py-2.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-colors appearance-none"
      >
        {children}
      </select>
    </div>
  );
}

function Textarea({
  label,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { label?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          {label}
        </label>
      )}
      <textarea
        {...props}
        className="w-full bg-input-background border border-border rounded-md px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-colors resize-none"
      />
    </div>
  );
}

function Btn({
  variant = "primary",
  size = "md",
  loading,
  children,
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  loading?: boolean;
}) {
  const base =
    "inline-flex items-center gap-2 font-medium rounded-md transition-all focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50 disabled:cursor-not-allowed";
  const variants = {
    primary:
      "bg-primary text-primary-foreground hover:bg-primary/90 active:scale-[0.98]",
    secondary:
      "bg-secondary text-secondary-foreground border border-border hover:bg-secondary/80",
    ghost: "text-muted-foreground hover:text-foreground hover:bg-secondary",
    danger:
      "bg-destructive/10 text-destructive border border-destructive/20 hover:bg-destructive/20",
  };
  const sizes = {
    sm: "px-3 py-1.5 text-xs",
    md: "px-4 py-2.5 text-sm",
    lg: "px-6 py-3 text-base",
  };
  return (
    <button
      {...props}
      disabled={props.disabled || loading}
      className={`${base} ${variants[variant]} ${sizes[size]} ${className}`}
    >
      {loading && (
        <RefreshCw size={14} className="animate-spin flex-shrink-0" />
      )}
      {children}
    </button>
  );
}

function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`bg-[#0B0F14]/80 backdrop-blur-md border border-red-500/10 rounded-xl shadow-[0_8px_32px_rgba(0,0,0,0.25)] hover:-translate-y-1 hover:shadow-[0_0_25px_rgba(239,68,68,0.10)] transition-all duration-300 ${className}`}
    >
      {children}
    </div>
  );
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative w-full sm:max-w-lg bg-card border border-border rounded-t-2xl sm:rounded-xl shadow-2xl max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border sticky top-0 bg-card z-10">
          <h2 className="font-heading font-bold text-xl text-foreground tracking-wide">
            {title}
          </h2>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors p-1"
          >
            <X size={20} />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

function Toast({
  message,
  type,
}: {
  message: string;
  type: "error" | "success";
}) {
  return (
    <div
      className={`fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] px-4 py-3 rounded-lg border text-sm font-medium shadow-xl flex items-center gap-2 max-w-sm w-[calc(100%-2rem)] ${
        type === "error"
          ? "bg-destructive/15 border-destructive/30 text-destructive"
          : "bg-primary/15 border-primary/30 text-primary"
      }`}
    >
      {type === "error" ? <AlertCircle size={15} /> : <CheckCircle size={15} />}
      {message}
    </div>
  );
}

// ─── Logo ─────────────────────────────────────────────────────────────────────

function Logo({
  size = "md",
  src,
}: {
  size?: "sm" | "md";
  src?: string | null;
}) {
  const small = size === "sm";

  return (
    <div
      className={
        small
          ? "flex justify-center items-center w-full h-24"
          : "flex justify-center items-center w-full h-28"
      }
    >
      <img
        src={src || "/vortanoficina-logo.png?v=10"}
        alt="Logo"
        className={
          small ? "h-36 w-auto object-contain" : "h-40 w-auto object-contain"
        }
      />
    </div>
  );
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

function AuthError({ msg }: { msg: string }) {
  if (!msg) return null;
  return (
    <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm">
      <AlertCircle size={14} className="flex-shrink-0" />
      {msg}
    </div>
  );
}

function LandingPage({
  onGoLogin,
  onGoRegister,
  onGoTerms,
  onGoPrivacy,
}: {
  onGoLogin: () => void;
  onGoRegister: () => void;
  onGoTerms: () => void;
  onGoPrivacy: () => void;
}) {
  const whatsappDemo =
    "https://wa.me/5527996126147?text=Olá,%20tenho%20interesse%20na%20Vortan%20Oficina%20e%20gostaria%20de%20falar%20com%20um%20consultor.";

  const features = [
    ["Ordens de Serviço", "Crie, acompanhe e envie OS profissionais."],
    ["Financeiro", "Controle faturamento, despesas e lucro."],
    ["Clientes e veículos", "Histórico completo sempre à mão."],
    ["WhatsApp e PDF", "Compartilhe atualizações com poucos cliques."],
    ["Link público", "Seu cliente acompanha o andamento online."],
    ["Sistema online", "Acesse pelo computador, tablet ou celular."],
  ];

  const stats = [
    {
      title: "OS digitais",
      text: "Crie, acompanhe e organize ordens de serviço",
      icon: ClipboardList,
    },
    {
      title: "Clientes",
      text: "Tenha histórico completo de cada cliente",
      icon: Users,
    },
    {
      title: "Veículos",
      text: "Consulte placas, modelos e serviços anteriores",
      icon: Car,
    },
    {
      title: "WhatsApp",
      text: "Envie atualizações direto para o cliente",
      icon: MessageCircle,
    },
  ];

  return (
    <div className="min-h-screen bg-[#030305] text-white relative overflow-hidden">
      <div className="fixed inset-0 pointer-events-none bg-[radial-gradient(circle_at_75%_20%,rgba(239,31,47,0.22),transparent_28%),radial-gradient(circle_at_20%_45%,rgba(239,31,47,0.10),transparent_30%),linear-gradient(180deg,rgba(255,255,255,0.04)_0%,rgba(255,255,255,0)_22%)]" />
      <div className="fixed inset-0 pointer-events-none opacity-[0.05] bg-[linear-gradient(rgba(239,31,47,1)_1px,transparent_1px),linear-gradient(90deg,rgba(239,31,47,1)_1px,transparent_1px)] bg-[size:88px_88px]" />

      <header
        className="
absolute top-0 left-0 right-0 z-20
bg-gradient-to-b
from-black/60
via-black/30
to-transparent
backdrop-blur-[1px]
"
      >
        <div className="max-w-7xl mx-auto px-5 h-24 flex items-center justify-between gap-4">
          <button
            onClick={onGoRegister}
            className="flex items-center gap-3 text-left"
          >
            <img
              src="/vortanoficina-logo.png?v=red"
              alt="Vortan Oficina"
              className="h-24 md:h-50 w-auto object-contain"
            />
          </button>

          <nav className="hidden lg:flex items-center gap-8 text-sm text-white/70">
            <a href="#inicio" className="text-primary font-semibold">
              Início
            </a>
            <a
              href="#funcionalidades"
              className="hover:text-white transition-colors"
            >
              Funcionalidades
            </a>
            <a href="#planos" className="hover:text-white transition-colors">
              Planos
            </a>
            <a href="#faq" className="hover:text-white transition-colors">
              Dúvidas
            </a>
          </nav>

          <div className="flex items-center gap-3">
            <Btn variant="secondary" onClick={onGoLogin}>
              Entrar
            </Btn>
            <a
              href={whatsappDemo}
              target="_blank"
              rel="noreferrer"
              className="hidden sm:inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2.5 text-sm font-bold text-primary-foreground hover:opacity-90 transition-opacity"
            >
              Falar com um consultor
            </a>
          </div>
        </div>
      </header>

      <main className="relative z-10">
        <section
          id="inicio"
          className="relative min-h-screen overflow-hidden border-b border-white/10 pt-24"
        >
          <div className="absolute inset-0">
            <img
              src="/vortan-hero-bg.png?v=1"
              alt="Oficina premium Vortan Oficina"
              className="h-full w-full object-cover object-center"
            />
            <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(0,0,0,0.92)_0%,rgba(0,0,0,0.72)_28%,rgba(0,0,0,0.42)_48%,rgba(0,0,0,0.18)_72%,rgba(0,0,0,0.08)_100%)]" />

            <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(0,0,0,0.58)_0%,rgba(0,0,0,0.18)_18%,rgba(0,0,0,0.02)_42%,rgba(0,0,0,0.28)_72%,rgba(0,0,0,0.82)_100%)]" />
            <div className="absolute inset-y-0 left-0 w-[58%] bg-[radial-gradient(circle_at_18%_42%,rgba(239,31,47,0.16),transparent_34%)]" />
          </div>

          <div className="relative z-10 max-w-7xl mx-auto px-5 min-h-[calc(100vh-96px)] flex items-center py-10 lg:py-16">
            <div className="max-w-2xl">
              <div className="text-primary font-bold uppercase tracking-[0.18em] text-sm md:text-base">
                Sistema para oficinas
              </div>

              <h1 className="mt-6 font-heading text-5xl md:text-7xl font-bold leading-[0.95] tracking-tight drop-shadow-2xl">
                Gestão completa para sua oficina
              </h1>

              <p className="mt-6 text-lg md:text-xl leading-relaxed text-white/74 max-w-xl">
                Organize ordens de serviço, controle financeiro, estoque,
                clientes e veículos em um só lugar. Mais eficiência, mais lucro.
              </p>

              <div className="mt-9 flex flex-col sm:flex-row gap-4">
                <Btn variant="primary" size="lg" onClick={onGoRegister}>
                  Conhecer o sistema
                  <ChevronRight size={18} />
                </Btn>
                <a
                  href={whatsappDemo}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center justify-center gap-3 rounded-lg border border-white/20 bg-black/45 px-6 py-3 text-sm font-bold text-white hover:bg-white/10 transition-colors backdrop-blur"
                >
                  <MessageCircle size={18} className="text-primary" />
                  Falar com um consultor
                </a>
              </div>

              <div className="mt-10 grid sm:grid-cols-3 gap-3 max-w-2xl">
                {[
                  [Gauge, "Mais controle", "Tudo da oficina na palma da mão."],
                  [Clock, "Mais agilidade", "Processos rápidos e integrados."],
                  [
                    TrendingUp,
                    "Mais lucro",
                    "Decisões inteligentes e resultados reais.",
                  ],
                ].map(([Icon, title, desc]) => {
                  const IconCmp = Icon as typeof Gauge;
                  return (
                    <div
                      key={String(title)}
                      className="rounded-2xl border border-white/10 bg-black/50 p-4 backdrop-blur-md shadow-xl shadow-black/30"
                    >
                      <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl border border-primary/25 bg-primary/10">
                        <IconCmp size={20} className="text-primary" />
                      </div>
                      <div className="font-bold text-sm">{title as string}</div>
                      <div className="text-xs text-white/58 mt-1">
                        {desc as string}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="relative z-10 max-w-7xl mx-auto px-5 -mt-28 pb-9 hidden lg:block">
            <div className="grid md:grid-cols-4 gap-3 rounded-3xl border border-white/10 bg-black/45 p-4 backdrop-blur-xl shadow-2xl shadow-red-950/25">
              {stats.map(({ title, text, icon: Icon }) => (
                <div
                  key={title}
                  className="flex items-center gap-4 rounded-2xl px-4 py-3"
                >
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-primary/15 border border-primary/20 shadow-[0_0_35px_rgba(239,31,47,0.18)]">
                    <Icon size={23} className="text-primary" />
                  </div>

                  <div>
                    <div className="text-primary text-xl font-bold">
                      {title}
                    </div>

                    <div className="text-sm text-white/70 mt-1">{text}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="planos" className="max-w-7xl mx-auto px-5 py-10">
          <div className="grid lg:grid-cols-[1.1fr_0.9fr] gap-6 items-stretch">
            <Card className="p-8 md:p-10 border-primary/20 bg-black/50">
              <div className="text-primary font-bold uppercase tracking-[0.22em] text-xs">
                Plano Fundadores
              </div>
              <h2 className="mt-3 text-4xl md:text-5xl font-bold">
                Comece com preço promocional.
              </h2>
              <p className="mt-4 text-muted-foreground max-w-2xl">
                Valor especial para os primeiros clientes da Vortan Oficina, com
                acesso aos recursos principais para organizar sua operação.
              </p>

              <div className="mt-7 flex items-end gap-2">
                <span className="text-6xl font-bold">R$ 29,90</span>
                <span className="text-muted-foreground mb-3">/mês</span>
              </div>

              <div className="mt-7 grid sm:grid-cols-2 gap-3 text-sm">
                {[
                  "Clientes ilimitados",
                  "Veículos ilimitados",
                  "Ordens de Serviço",
                  "Financeiro",
                  "PDF profissional",
                  "Suporte inicial",
                ].map((item) => (
                  <div
                    key={item}
                    className="flex items-center gap-2 text-white/80"
                  >
                    <CheckCircle size={16} className="text-primary" />
                    {item}
                  </div>
                ))}
              </div>
            </Card>

            <Card className="p-8 bg-[radial-gradient(circle_at_top_right,rgba(239,31,47,0.18),transparent_35%),rgba(0,0,0,0.55)] border-white/10">
              <div className="text-xs text-muted-foreground mb-2 uppercase tracking-[0.2em]">
                Painel Vortan
              </div>
              <h3 className="text-3xl font-bold mb-5">
                Tudo que sua oficina precisa
              </h3>
              <div className="space-y-3">
                {features.slice(0, 5).map(([title, desc]) => (
                  <div
                    key={title}
                    className="rounded-xl border border-white/10 bg-white/[0.03] p-4"
                  >
                    <div className="font-bold text-primary">{title}</div>
                    <div className="text-sm text-muted-foreground mt-1">
                      {desc}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </section>

        <section className="max-w-7xl mx-auto px-5 py-16">
          <div className="text-center mb-8">
            <h2 className="font-heading font-bold text-4xl">
              Veja a Vortan Oficina em ação
            </h2>
            <p className="text-muted-foreground mt-2">
              Dashboard real do sistema, com visual profissional para a rotina
              da oficina.
            </p>
          </div>

          <Card className="overflow-hidden border-primary/20 max-w-6xl mx-auto bg-black/70 shadow-2xl shadow-red-950/20">
            <img
              src="/dashboard-real.png?v=1"
              alt="Dashboard Vortan Oficina"
              className="w-full object-cover"
            />
          </Card>
        </section>

        <section id="funcionalidades" className="max-w-7xl mx-auto px-5 py-14">
          <div className="text-center mb-9">
            <h2 className="font-heading font-bold text-4xl">
              Recursos que simplificam o dia a dia
            </h2>
            <p className="text-muted-foreground mt-2">
              Menos bagunça, menos papel e mais controle dentro da oficina.
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-4">
            {features.map(([title, desc]) => (
              <Card
                key={title}
                className="p-5 bg-black/45 border-white/10 hover:border-primary/35 transition-colors"
              >
                <CheckCircle size={20} className="text-primary mb-4" />
                <p className="font-bold">{title}</p>
                <p className="text-sm text-muted-foreground mt-2">{desc}</p>
              </Card>
            ))}
          </div>
        </section>

        <section className="max-w-5xl mx-auto px-5 py-16">
          <Card className="text-center p-8 md:p-12 border-primary/20 bg-[radial-gradient(circle_at_center,rgba(239,31,47,0.15),transparent_55%),rgba(0,0,0,0.58)]">
            <h2 className="text-4xl md:text-5xl font-bold">
              Pronto para organizar sua oficina?
            </h2>
            <p className="text-muted-foreground mt-4 max-w-2xl mx-auto">
              Comece hoje mesmo a controlar clientes, veículos, ordens de
              serviço e financeiro em um único lugar.
            </p>
            <div className="mt-8 flex flex-col sm:flex-row gap-3 justify-center">
              <Btn variant="primary" size="lg" onClick={onGoRegister}>
                Começar Agora
              </Btn>
              <Btn variant="secondary" size="lg" onClick={onGoLogin}>
                Já tenho conta
              </Btn>
            </div>
          </Card>
        </section>

        <section id="faq" className="max-w-5xl mx-auto px-5 py-14">
          <div className="text-center mb-8">
            <h2 className="font-heading font-bold text-4xl">
              Perguntas frequentes
            </h2>
            <p className="text-muted-foreground mt-2">
              Tudo que você precisa saber antes de começar.
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            {[
              [
                "Precisa instalar?",
                "Não. A Vortan Oficina funciona direto pelo navegador, sem instalação.",
              ],
              [
                "Funciona no celular?",
                "Sim. Você pode acessar pelo computador, tablet ou celular.",
              ],
              [
                "Os dados ficam salvos?",
                "Sim. As informações ficam armazenadas online com segurança.",
              ],
              [
                "Tem suporte?",
                "Sim. Clientes do plano fundador contam com suporte dedicado.",
              ],
            ].map(([title, desc]) => (
              <Card key={title} className="p-5 bg-black/45 border-white/10">
                <CheckCircle size={18} className="text-primary mb-3" />
                <p className="font-bold">{title}</p>
                <p className="text-sm text-muted-foreground mt-2">{desc}</p>
              </Card>
            ))}
          </div>
        </section>
      </main>

      <footer className="relative z-10 border-t border-white/10 py-8 bg-black/60">
        <div className="max-w-7xl mx-auto px-5 flex flex-col md:flex-row items-center justify-between gap-5 text-sm text-muted-foreground">
          <div className="text-center md:text-left">
            <div className="font-bold text-foreground">Vortan Oficina</div>
            <div>Gestão completa para oficinas modernas.</div>
          </div>

          <div className="text-center">
            <div>Contato</div>
            <a
              href="https://wa.me/5527996126147"
              target="_blank"
              rel="noreferrer"
              className="block text-primary hover:underline"
            >
              WhatsApp: (27) 99612-6147
            </a>
            <a
              href="mailto:contato.vortanoficina@gmail.com"
              className="block text-primary hover:underline"
            >
              contato.vortanoficina@gmail.com
            </a>
          </div>

          <div className="flex gap-4">
            <button
              onClick={onGoTerms}
              className="hover:text-primary transition-colors"
            >
              Termos
            </button>
            <button
              onClick={onGoPrivacy}
              className="hover:text-primary transition-colors"
            >
              Privacidade
            </button>
          </div>

          <div className="text-center md:text-right text-xs">
            <div>Desenvolvido por Vortan Systems</div>
            <div>© 2026 Vortan Oficina</div>
          </div>
        </div>
      </footer>
    </div>
  );
}

function LoginScreen({ onGoRegister }: { onGoRegister: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handle(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      setError(
        error.message === "Invalid login credentials"
          ? "E-mail ou senha incorretos."
          : "Não foi possível entrar. Verifique seus dados e tente novamente.",
      );
    }

    setLoading(false);
  }

  async function handleForgotPassword() {
    setError("");

    if (!email) {
      setError("Digite seu e-mail acima para recuperar a senha.");
      return;
    }

    setLoading(true);

    const { error: resetError } = await supabase.auth.resetPasswordForEmail(
      email,
      {
        redirectTo: "https://www.vortanoficina.com.br?reset-password=true",
      },
    );

    if (resetError) {
      setError(
        "Não foi possível enviar o e-mail de recuperação. Tente novamente.",
      );
    } else {
      setError("Enviamos um link de recuperação para o seu e-mail.");
    }

    setLoading(false);
  }

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <Logo />
          <p className="text-sm text-muted-foreground mt-2">
            Gestão inteligente para sua oficina
          </p>
        </div>
        <Card className="p-6">
          <h1 className="font-heading font-bold text-xl mb-5 text-foreground">
            Entrar
          </h1>
          <form onSubmit={handle} className="flex flex-col gap-4">
            <Input
              label="E-mail"
              type="email"
              placeholder="email@oficina.com.br"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
            <Input
              label="Senha"
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
            <button
              type="button"
              onClick={handleForgotPassword}
              className="text-xs text-primary hover:underline text-right"
            >
              Esqueci minha senha
            </button>

            <AuthError msg={error} />
            <Btn
              type="submit"
              variant="primary"
              className="w-full justify-center"
              loading={loading}
            >
              {!loading && "Entrar"}
            </Btn>
          </form>
        </Card>
        <p className="text-center text-sm text-muted-foreground mt-4">
          Não tem conta?{" "}
          <button
            onClick={onGoRegister}
            className="text-primary hover:underline font-medium"
          >
            Cadastrar oficina
          </button>
        </p>
      </div>
    </div>
  );
}

function RegisterScreen({ onGoLogin }: { onGoLogin: () => void }) {
  const [form, setForm] = useState({
    name: "",
    workshopName: "",
    email: "",
    password: "",
    confirm: "",
  });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [pendingEmail, setPendingEmail] = useState("");

  const set =
    (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((p) => ({ ...p, [k]: e.target.value }));

  async function handle(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (form.password !== form.confirm) {
      setError("Senhas não coincidem.");
      return;
    }

    if (form.password.length < 8) {
      setError("A senha precisa ter pelo menos 8 caracteres.");
      return;
    }

    if (!/[A-Z]/.test(form.password)) {
      setError("A senha precisa ter pelo menos uma letra maiúscula.");
      return;
    }

    if (!/[a-z]/.test(form.password)) {
      setError("A senha precisa ter pelo menos uma letra minúscula.");
      return;
    }

    if (!/[0-9]/.test(form.password)) {
      setError("A senha precisa ter pelo menos um número.");
      return;
    }

    setLoading(true);

    localStorage.setItem(
      "vortanoficina_pending_profile",
      JSON.stringify({
        owner_name: form.name,
        workshop_name: form.workshopName,
      }),
    );

    const { error } = await supabase.auth.signUp({
      email: form.email,
      password: form.password,
      options: {
        emailRedirectTo: window.location.origin,
        data: {
          name: form.name.trim(),
          owner_name: form.name.trim(),
          workshop_name: form.workshopName.trim(),
          business_name: form.workshopName.trim(),
          shop_name: form.workshopName.trim(),
        },
      },
    });

    if (error) {
      localStorage.removeItem("vortanoficina_pending_profile");

      if (
        error.message.toLowerCase().includes("password") ||
        error.message.toLowerCase().includes("senha")
      ) {
        setError(
          "A senha precisa ter pelo menos 8 caracteres, com maiúscula, minúscula e número.",
        );
      } else if (
        error.message.toLowerCase().includes("user already registered")
      ) {
        setError("Já existe uma conta cadastrada com este e-mail.");
      } else {
        setError("Não foi possível concluir o cadastro. Tente novamente.");
      }

      setLoading(false);
      return;
    }

    setPendingEmail(form.email);
    setLoading(false);
  }

  if (pendingEmail) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center px-4 py-8">
        <div className="w-full max-w-md text-center">
          <Logo />

          <Card className="p-6 mt-8">
            <div className="w-12 h-12 rounded-full bg-primary/15 border border-primary/25 mx-auto mb-4 flex items-center justify-center">
              <CheckCircle size={24} className="text-primary" />
            </div>

            <h1 className="font-heading font-bold text-2xl mb-3 text-foreground">
              Confirme seu e-mail
            </h1>

            <p className="text-sm text-muted-foreground mb-3">
              Enviamos um link de confirmação para:
            </p>

            <p className="text-primary font-semibold mb-5 break-all">
              {pendingEmail}
            </p>

            <p className="text-sm text-muted-foreground">
              Depois de confirmar pelo link recebido, você volta automaticamente
              para a Vortan Oficina.
            </p>
          </Card>

          <button
            onClick={onGoLogin}
            className="text-primary hover:underline font-medium mt-5 text-sm"
          >
            Voltar para login
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-4 py-8">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-6">
          <Logo />

          <button
            type="button"
            onClick={onGoLogin}
            className="mb-4 inline-flex items-center gap-2 rounded-lg border border-red-500/30 px-4 py-2 text-sm font-semibold text-red-400 hover:bg-red-500/10 transition"
          >
            ← Voltar para login
          </button>

          <p className="text-sm text-muted-foreground mt-2 text-center">
            Cadastre sua oficina
          </p>
        </div>
        <Card className="p-6">
          <form onSubmit={handle} className="flex flex-col gap-4">
            <Input
              label="Seu nome"
              placeholder="Ex: João Souza"
              value={form.name}
              onChange={set("name")}
              required
            />
            <Input
              label="Nome da oficina"
              placeholder="Ex: Oficina Central"
              value={form.workshopName}
              onChange={set("workshopName")}
              required
            />
            <Input
              label="E-mail"
              type="email"
              placeholder="Ex: contato@oficina.com.br"
              value={form.email}
              onChange={set("email")}
              required
            />
            <Input
              label="Senha"
              type="password"
              placeholder="Mínimo 8 caracteres"
              value={form.password}
              onChange={set("password")}
              required
            />
            <Input
              label="Confirmar senha"
              type="password"
              placeholder="Repita a senha"
              value={form.confirm}
              onChange={set("confirm")}
              required
            />
            <AuthError msg={error} />
            <Btn
              type="submit"
              variant="primary"
              className="w-full justify-center"
              loading={loading}
            >
              {!loading && "Criar conta"}
            </Btn>
          </form>
        </Card>
        <p className="text-center text-sm text-muted-foreground mt-4">
          Já tem conta?{" "}
          <button
            onClick={onGoLogin}
            className="text-primary hover:underline font-medium"
          >
            Fazer login
          </button>
        </p>
      </div>
    </div>
  );
}

// Onboarding for users who signed up without a profile (email confirmation flow)
function OnboardingScreen({
  user,
  onDone,
}: {
  user: User;
  onDone: (p: Profile) => void;
}) {
  const [form, setForm] = useState({ owner_name: "", workshop_name: "" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const set =
    (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((p) => ({ ...p, [k]: e.target.value }));

  async function handle(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const profile = await API.upsertProfile(form);
      onDone(profile);
    } catch (err: any) {
      setError(err.message);
    }
    setLoading(false);
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    window.location.reload();
  }
  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <Logo />
          <p className="text-sm text-muted-foreground mt-2">
            Bem-vindo! Complete seu cadastro
          </p>
        </div>
        <Card className="p-6">
          <form onSubmit={handle} className="flex flex-col gap-4">
            <Input
              label="Seu nome"
              placeholder="Ex: João Souza"
              value={form.owner_name}
              onChange={set("owner_name")}
              required
            />
            <Input
              label="Nome da oficina"
              placeholder="Ex: Oficina Central"
              value={form.workshop_name}
              onChange={set("workshop_name")}
              required
            />
            <AuthError msg={error} />
            <Btn
              type="submit"
              variant="primary"
              className="w-full justify-center"
              loading={loading}
            >
              {!loading && "Salvar e continuar"}
            </Btn>
          </form>
        </Card>
        <button
          type="button"
          onClick={handleLogout}
          className="text-red-500 hover:text-red-400 text-sm"
        >
          Sair
        </button>
      </div>
    </div>
  );
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────

const NAV = [
  { page: "dashboard" as Page, label: "Dashboard", icon: LayoutDashboard },
  { page: "budgets" as Page, label: "Orçamentos", icon: FileText },
  { page: "orders" as Page, label: "Ordens de Serviço", icon: ClipboardList },
  { page: "clients" as Page, label: "Clientes", icon: Users },
  { page: "vehicles" as Page, label: "Veículos", icon: Car },
  { page: "history" as Page, label: "Histórico", icon: History },
  {
    page: "financial" as Page,
    label: "Financeiro",
    icon: DollarSign,
  },
  {
    page: "admin" as Page,
    label: "Admin Vortan",
    icon: Shield,
  },
  {
    page: "settings" as Page,
    label: "Configurações",
    icon: Building2,
  },
];

function Sidebar({
  profile,
  page,
  onNav,
  onLogout,
  open,
  onClose,
}: {
  profile: Profile | null;
  page: Page;
  onNav: (p: Page) => void;
  onLogout: () => void;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <>
      {open && (
        <div
          className="fixed inset-0 bg-black/50 z-30 lg:hidden"
          onClick={onClose}
        />
      )}
      <aside
        className={`fixed top-0 left-0 h-full w-64 bg-[#070A0D]/90 backdrop-blur-xl border-r border-red-500/10 flex flex-col z-40 transition-transform duration-200 lg:translate-x-0 shadow-[20px_0_80px_rgba(239,68,68,0.08)] ${open ? "translate-x-0" : "-translate-x-full"}`}
      >
        <div className="relative px-4 py-4 border-b border-red-500/10 overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-br from-red-500/10 via-transparent to-transparent pointer-events-none" />
          <div className="relative z-10"></div>
          <Logo size="sm" />

          {profile && (
            <div className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground pl-9">
              <Building2 size={10} />
              <span className="truncate">{profile.workshop_name}</span>
            </div>
          )}
        </div>

        <nav className="flex-1 px-2 py-3 flex flex-col gap-0.5 overflow-y-auto">
          {NAV.filter((item) => {
            if (item.page === "admin") {
              return profile?.is_admin;
            }

            return true;
          }).map(({ page: p, label, icon: Icon }) => {
            const active =
              page === p || (page === "order-detail" && p === "orders");
            return (
              <button
                key={p}
                onClick={() => {
                  onNav(p);
                  onClose();
                }}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-all ${
                  active
                    ? "bg-red-500/15 text-red-400 border border-red-500/25 shadow-[0_0_25px_rgba(239,68,68,0.18)]"
                    : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                }`}
              >
                <Icon size={16} />
                {label}
              </button>
            );
          })}

          <button
            type="button"
            onClick={() => {
              window.open(
                "https://wa.me/5527996126147?text=Olá,%20preciso%20de%20suporte%20com%20a%20Vortan%20Oficina.",
                "_blank",
                "noopener,noreferrer" /* CONTATO SUPORTE 5527996126147*/,
              );
              onClose();
            }}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium text-red-400 hover:bg-red-500/10 border border-red-500/15 transition-all mt-2"
          >
            <MessageCircle size={16} />
            Suporte 24h
          </button>
        </nav>

        <div className="px-2 py-3 border-t border-sidebar-border">
          {profile && (
            <div className="mx-2 mb-3 p-3 rounded-xl border border-red-500/10 bg-red-500/[0.03]">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-red-500/15 border border-red-500/20 flex items-center justify-center text-red-400 font-semibold">
                  {profile.owner_name?.charAt(0)?.toUpperCase()}
                </div>

                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground truncate">
                    {profile.owner_name}
                  </div>

                  <div className="text-xs text-muted-foreground truncate">
                    {profile.workshop_name}
                  </div>
                </div>
              </div>

              <div className="mt-3 flex justify-center">
                <span className="text-[10px] px-2 py-1 rounded-full bg-red-500/10 border border-red-500/20 text-red-400">
                  Plano Fundadores
                </span>
              </div>
            </div>
          )}

          <div className="px-3 pb-3 text-center">
            <div className="text-[10px] text-muted-foreground">
              Vortan Oficina v1.0.0
            </div>

            <div className="flex justify-center gap-3 mt-2 text-[10px]">
              <a
                href="https://instagram.com/vortanoficina"
                target="_blank"
                rel="noreferrer"
                className="text-muted-foreground hover:text-red-400 transition-colors"
              >
                Instagram
              </a>

              <a
                href="https://www.vortanoficina.com.br"
                target="_blank"
                rel="noreferrer"
                className="text-muted-foreground hover:text-red-400 transition-colors"
              >
                Site
              </a>
            </div>
          </div>

          <button
            onClick={onLogout}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-all"
          >
            <LogOut size={15} /> Sair
          </button>
        </div>
      </aside>
    </>
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

function Dashboard({
  clients,
  vehicles,
  orders,
  profile,
  onNav,
  onViewOrder,
}: {
  clients: Client[];
  vehicles: Vehicle[];
  orders: ServiceOrder[];
  profile: any;
  onNav: (p: Page) => void;
  onViewOrder: (o: ServiceOrder) => void;
}) {
  const getTrialDaysLeft = (endDate: string) => {
    const end = new Date(endDate).getTime();
    const now = new Date().getTime();
    const diff = end - now;
    const days = Math.ceil(diff / (1000 * 60 * 60 * 24));

    return Math.max(days, 0);
  };

  const trialDaysLeft = profile?.subscription_ends_at
    ? getTrialDaysLeft(profile.subscription_ends_at)
    : 0;

  const totalTrialDays = 15;

  const trialProgress = profile?.subscription_ends_at
    ? Math.min(
        100,
        Math.max(0, ((totalTrialDays - trialDaysLeft) / totalTrialDays) * 100),
      )
    : 0;

  const now = new Date();
  const currentMonth = now.getMonth();
  const currentYear = now.getFullYear();
  const todayKey = now.toISOString().slice(0, 10);

  const done = orders.filter((o) => o.status === "finalizado");
  const activeOrdersList = orders.filter((o) => o.status !== "finalizado");
  const waiting = orders.filter((o) => o.status === "aguardando");
  const inProgress = orders.filter((o) => o.status === "em_manutencao");

  const totalRevenue = done.reduce(
    (acc, o) => acc + Number(String(o.value || "0").replace(",", ".")),
    0,
  );

  const monthlyRevenue = orders
    .filter((o) => {
      const d = new Date(o.updated_at);
      return (
        o.status === "finalizado" &&
        d.getMonth() === currentMonth &&
        d.getFullYear() === currentYear
      );
    })
    .reduce(
      (acc, o) => acc + Number(String(o.value || "0").replace(",", ".")),
      0,
    );

  const monthlyDone = done.filter((o) => {
    const d = new Date(o.updated_at);
    return d.getMonth() === currentMonth && d.getFullYear() === currentYear;
  });

  const completionRate =
    orders.length > 0 ? Math.round((done.length / orders.length) * 100) : 0;

  const averageTicket = done.length > 0 ? totalRevenue / done.length : 0;

  const openRevenue = activeOrdersList.reduce(
    (acc, o) => acc + Number(String(o.value || "0").replace(",", ".")),
    0,
  );

  const recent = [...orders]
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, 5);

  const deliveriesToday = orders.filter((o) => {
    const delivery = (o as any).delivery_date;
    if (!delivery || o.status === "finalizado") return false;
    return String(delivery).slice(0, 10) === todayKey;
  });

  const overdueDeliveries = orders.filter((o) => {
    const delivery = (o as any).delivery_date;
    if (!delivery || o.status === "finalizado") return false;
    return new Date(delivery).getTime() < new Date(todayKey).getTime();
  });

  const staleOrders = activeOrdersList.filter((o) => {
    const updated = new Date(o.updated_at || o.created_at).getTime();
    const days = Math.floor((Date.now() - updated) / 86400000);
    return days >= 3;
  });

  const clientsWithoutWhatsApp = clients.filter(
    (c) => !String(c.whatsapp || c.phone || "").replace(/\D/g, ""),
  );

  const attentionItems = [
    staleOrders.length > 0
      ? {
          label: `${staleOrders.length} OS parada(s)`,
          description: "Há mais de 3 dias",
        }
      : null,
    overdueDeliveries.length > 0
      ? {
          label: `${overdueDeliveries.length} entrega(s) atrasada(s)`,
          description: "Passaram da previsão",
        }
      : null,
    deliveriesToday.length > 0
      ? {
          label: `${deliveriesToday.length} entrega(s) hoje`,
          description: "Previstas para hoje",
        }
      : null,
    clientsWithoutWhatsApp.length > 0
      ? {
          label: `${clientsWithoutWhatsApp.length} cliente(s) sem contato`,
          description: "Complete telefone/WhatsApp",
        }
      : null,
  ].filter(Boolean) as { label: string; description: string }[];

  const activityItems = orders
    .slice()
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, 5)
    .map((order) => {
      const client = clients.find((c) => c.id === order.client_id);
      const vehicle = vehicles.find((v) => v.id === order.vehicle_id);

      return {
        id: order.id,
        title:
          order.status === "finalizado"
            ? `${client?.name || "Cliente"} finalizou uma OS`
            : `${client?.name || "Cliente"} atualizou uma OS`,
        description: vehicle
          ? `${vehicle.brand} ${vehicle.model} · ${vehicle.plate}`
          : "Ordem de serviço",
        date: order.updated_at || order.created_at,
        order,
      };
    });

  const greeting =
    now.getHours() < 12
      ? "Bom dia"
      : now.getHours() < 18
        ? "Boa tarde"
        : "Boa noite";

  function exportClients() {
    downloadCSV(
      "clientes.csv",
      clients.map((c) => ({
        nome: c.name,
        telefone: c.phone,
        whatsapp: c.whatsapp,
        criado_em: new Date(c.created_at).toLocaleDateString("pt-BR"),
      })),
    );
  }

  function exportVehicles() {
    downloadCSV(
      "veiculos.csv",
      vehicles.map((v) => {
        const client = clients.find((c) => c.id === v.client_id);
        return {
          cliente: client?.name ?? "",
          placa: v.plate,
          marca: v.brand,
          modelo: v.model,
          ano: v.year,
          quilometragem: v.mileage,
          criado_em: new Date(v.created_at).toLocaleDateString("pt-BR"),
        };
      }),
    );
  }

  function exportOrders() {
    downloadCSV(
      "ordens-servico.csv",
      orders.map((o) => {
        const client = clients.find((c) => c.id === o.client_id);
        const vehicle = vehicles.find((v) => v.id === o.vehicle_id);
        return {
          cliente: client?.name ?? "",
          veiculo: vehicle ? `${vehicle.brand} ${vehicle.model}` : "",
          placa: vehicle?.plate ?? "",
          problema_relatado: o.reported_issue,
          servicos_executados: o.services_performed,
          status: STATUS_LABEL[o.status],
          valor: o.value,
          data_prevista_entrega: (o as any).delivery_date ?? "",
          observacoes: o.notes,
          criado_em: new Date(o.created_at).toLocaleDateString("pt-BR"),
          atualizado_em: o.updated_at,
        };
      }),
    );
  }

  function exportFinance() {
    downloadCSV(
      "financeiro.csv",
      orders.map((o) => {
        const client = clients.find((c) => c.id === o.client_id);
        const vehicle = vehicles.find((v) => v.id === o.vehicle_id);
        const value = Number(String(o.value || "0").replace(",", "."));
        return {
          cliente: client?.name ?? "",
          placa: vehicle?.plate ?? "",
          status: STATUS_LABEL[o.status],
          valor: value.toFixed(2).replace(".", ","),
          recebido: o.status === "finalizado" ? "Sim" : "Não",
          data_referencia: new Date(o.updated_at).toLocaleString("pt-BR"),
        };
      }),
    );
  }

  return (
    <div className="space-y-5">
      {profile?.subscription_status === "trial" && (
        <div
          className={`mb-6 overflow-hidden rounded-2xl border shadow-lg ${
            trialDaysLeft <= 3
              ? "border-red-500/30 bg-red-500/10"
              : trialDaysLeft <= 7
                ? "border-yellow-500/30 bg-yellow-500/10"
                : "border-green-500/30 bg-green-500/10"
          }`}
        >
          <div className="flex items-center justify-between border-b border-white/10 px-6 py-4">
            <div>
              <h2
                className={`text-xl font-bold ${
                  trialDaysLeft <= 3
                    ? "text-red-300"
                    : trialDaysLeft <= 7
                      ? "text-yellow-300"
                      : "text-green-300"
                }`}
              >
                {trialDaysLeft <= 3
                  ? "⚠️ Seu teste está acabando"
                  : "🎉 Teste grátis ativo"}
              </h2>

              <p className="mt-1 text-sm text-muted-foreground">
                Aproveite todos os recursos da Vortan Oficina sem limitações.
              </p>
            </div>

            <div
              className={`rounded-full border px-3 py-1 ${
                trialDaysLeft <= 3
                  ? "border-red-500/30 bg-red-500/15"
                  : trialDaysLeft <= 7
                    ? "border-yellow-500/30 bg-yellow-500/15"
                    : "border-green-500/30 bg-green-500/15"
              }`}
            >
              <span
                className={`text-xs font-bold uppercase tracking-widest ${
                  trialDaysLeft <= 3
                    ? "text-red-300"
                    : trialDaysLeft <= 7
                      ? "text-yellow-300"
                      : "text-green-300"
                }`}
              >
                Trial
              </span>
            </div>
          </div>

          <div className="px-6 py-5">
            <div className="mb-2 flex justify-between text-sm">
              <span className="text-muted-foreground">Progresso do teste</span>

              <span className="font-semibold text-muted-foreground">
                {15 - trialDaysLeft} / 15 dias
              </span>
            </div>

            <div className="h-3 overflow-hidden rounded-full bg-white/10">
              <div
                className={`h-full rounded-full bg-gradient-to-r transition-all duration-700 ${
                  trialDaysLeft <= 3
                    ? "from-red-500 to-red-400"
                    : trialDaysLeft <= 7
                      ? "from-yellow-400 to-amber-500"
                      : "from-green-400 to-emerald-500"
                }`}
                style={{ width: `${trialProgress}%` }}
              />
            </div>

            <div className="mt-5 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <p
                  className={`text-lg font-bold ${
                    trialDaysLeft <= 3
                      ? "text-red-300"
                      : trialDaysLeft <= 7
                        ? "text-yellow-300"
                        : "text-green-300"
                  }`}
                >
                  Restam {trialDaysLeft} dias
                </p>

                <p className="mt-1 text-xs text-muted-foreground">
                  Expira em{" "}
                  {new Date(profile.subscription_ends_at).toLocaleDateString(
                    "pt-BR",
                  )}
                </p>

                <p className="mt-2 text-sm text-muted-foreground">
                  Após o término do teste será necessário contratar um plano
                  para continuar utilizando o sistema.
                </p>
              </div>

              <button
                onClick={() => onNav("billing")}
                className="rounded-xl bg-gradient-to-r from-red-600 to-red-500 px-6 py-3 font-semibold text-white transition hover:scale-[1.02] hover:from-red-500 hover:to-red-400"
              >
                Assinar agora
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="overflow-hidden rounded-3xl border border-red-500/20 bg-gradient-to-br from-red-500/10 via-card to-black/40 p-5 shadow-[0_0_35px_rgba(239,68,68,0.08)]">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="inline-flex rounded-full border border-red-500/20 bg-red-500/10 px-3 py-1 text-xs font-bold uppercase tracking-[0.18em] text-red-300">
              Painel da Oficina
            </div>

            <h1 className="mt-4 font-heading text-3xl font-black tracking-tight text-foreground">
              {greeting}, {profile?.owner_name || "gestor"} 👋
            </h1>

            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              {profile?.workshop_name
                ? `Resumo rápido da ${profile.workshop_name}.`
                : "Resumo rápido da sua oficina."}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:min-w-[360px]">
            <button
              onClick={() => onNav("orders")}
              className="rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-left transition hover:bg-red-500/20"
            >
              <Plus size={18} className="mb-2 text-red-300" />
              <p className="text-sm font-bold text-white">Nova OS</p>
              <p className="text-xs text-muted-foreground">Criar serviço</p>
            </button>

            <button
              onClick={() => onNav("clients")}
              className="rounded-2xl border border-white/10 bg-white/5 p-4 text-left transition hover:bg-white/10"
            >
              <Users size={18} className="mb-2 text-red-300" />
              <p className="text-sm font-bold text-white">Cliente</p>
              <p className="text-xs text-muted-foreground">Abrir cadastro</p>
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs text-muted-foreground">
                Faturamento do Mês
              </div>
              <div className="mt-2 text-2xl font-bold text-green-500">
                {fmtMoney(monthlyRevenue)}
              </div>
            </div>
            <DollarSign size={20} className="text-green-500" />
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs text-muted-foreground">OS Ativas</div>
              <div className="mt-2 text-2xl font-bold text-amber-400">
                {activeOrdersList.length}
              </div>
            </div>
            <Wrench size={20} className="text-amber-400" />
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs text-muted-foreground">Entregas Hoje</div>
              <div className="mt-2 text-2xl font-bold text-blue-400">
                {deliveriesToday.length}
              </div>
            </div>
            <Calendar size={20} className="text-blue-400" />
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs text-muted-foreground">Conclusão</div>
              <div className="mt-2 text-2xl font-bold text-red-400">
                {completionRate}%
              </div>
            </div>
            <Target size={20} className="text-red-400" />
          </div>
        </Card>
      </div>

      <Card className="p-1">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <AlertCircle size={10} className="text-primary" />
            <div>
              <h2 className="font-heading text-base font-bold text-foreground">
                Centro de atenção
              </h2>
              <p className="text-xs text-muted-foreground">
                O que merece atenção agora.
              </p>
            </div>
          </div>

          {attentionItems.length === 0 ? (
            <div className="rounded-xl border border-green-500/20 bg-green-500/10 px-4 py-3 text-sm font-semibold text-green-300">
              Tudo certo por aqui.
            </div>
          ) : (
            <div className="grid flex-1 gap-2 md:grid-cols-2 xl:grid-cols-4">
              {attentionItems.map((item) => (
                <div
                  key={item.label}
                  className="rounded-xl border border-yellow-500/20 bg-yellow-500/10 px-4 py-3"
                >
                  <p className="text-sm font-bold text-yellow-200">
                    ⚠️ {item.label}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {item.description}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div>
              <h2 className="font-heading text-base font-semibold text-foreground">
                Ordens Recentes
              </h2>
              <p className="text-xs text-muted-foreground">
                Últimas movimentações de serviço.
              </p>
            </div>

            <button
              onClick={() => onNav("orders")}
              className="text-xs font-semibold text-primary hover:underline"
            >
              Ver todas
            </button>
          </div>

          {recent.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <ClipboardList
                size={28}
                className="mx-auto mb-2 text-muted-foreground/20"
              />
              <p className="text-sm text-muted-foreground">
                Nenhuma ordem de serviço ainda.
              </p>
              <Btn
                variant="primary"
                size="sm"
                className="mx-auto mt-3"
                onClick={() => onNav("orders")}
              >
                <Plus size={13} /> Criar primeira OS
              </Btn>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {recent.map((o) => {
                const client = clients.find((c) => c.id === o.client_id);
                const vehicle = vehicles.find((v) => v.id === o.vehicle_id);

                return (
                  <button
                    key={o.id}
                    onClick={() => onViewOrder(o)}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-secondary/40"
                  >
                    <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/5">
                      <Car size={15} className="text-primary" />
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-foreground">
                          {vehicle
                            ? `${vehicle.brand} ${vehicle.model}`
                            : "Veículo não informado"}
                        </span>
                        <StatusBadge status={o.status} />
                      </div>
                      <div className="mt-0.5 truncate text-xs text-muted-foreground">
                        {client?.name ?? "Cliente não informado"} ·{" "}
                        {vehicle?.plate ?? "Sem placa"} · {fmt(o.created_at)}
                      </div>
                    </div>

                    <div className="flex-shrink-0 text-sm font-medium text-green-500">
                      {fmtMoney(o.value)}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </Card>

        <Card>
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div>
              <h2 className="font-heading text-base font-semibold text-foreground">
                Atividade recente
              </h2>
              <p className="text-xs text-muted-foreground">
                Últimos acontecimentos da oficina.
              </p>
            </div>

            <RefreshCw size={16} className="text-primary" />
          </div>

          {activityItems.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <Clock
                size={28}
                className="mx-auto mb-2 text-muted-foreground/20"
              />
              <p className="text-sm text-muted-foreground">
                Ainda não há atividades recentes.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {activityItems.map((item) => (
                <button
                  key={item.id}
                  onClick={() => onViewOrder(item.order)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-secondary/40"
                >
                  <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl border border-red-500/20 bg-red-500/10">
                    <CheckCircle size={15} className="text-red-300" />
                  </div>

                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">
                      {item.title}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {item.description}
                    </p>
                  </div>

                  <div className="text-xs text-muted-foreground">
                    {fmt(item.date)}
                  </div>
                </button>
              ))}
            </div>
          )}
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h2 className="font-heading text-base font-bold text-foreground">
                Resumo rápido
              </h2>
              <p className="text-xs text-muted-foreground">
                Números úteis sem ocupar o topo.
              </p>
            </div>
            <TrendingUp size={18} className="text-primary" />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
              <p className="text-xs text-muted-foreground">Total</p>
              <p className="mt-1 text-sm font-bold text-green-500">
                {fmtMoney(totalRevenue)}
              </p>
            </div>

            <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
              <p className="text-xs text-muted-foreground">Média</p>
              <p className="mt-1 text-sm font-bold text-blue-400">
                {fmtMoney(averageTicket)}
              </p>
            </div>

            <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
              <p className="text-xs text-muted-foreground">Mês</p>
              <p className="mt-1 text-sm font-bold text-emerald-400">
                {monthlyDone.length} OS
              </p>
            </div>

            <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
              <p className="text-xs text-muted-foreground">Aberto</p>
              <p className="mt-1 text-sm font-bold text-amber-400">
                {fmtMoney(openRevenue)}
              </p>
            </div>
          </div>
        </Card>

        <Card className="p-4 xl:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h2 className="font-heading text-base font-bold text-foreground">
                Ferramentas rápidas
              </h2>
              <p className="text-xs text-muted-foreground">
                Exportações CSV e atalhos úteis.
              </p>
            </div>
            <Download size={18} className="text-primary" />
          </div>

          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            <Btn
              variant="secondary"
              size="sm"
              className="justify-center"
              onClick={exportClients}
            >
              Clientes CSV
            </Btn>

            <Btn
              variant="secondary"
              size="sm"
              className="justify-center"
              onClick={exportVehicles}
            >
              Veículos CSV
            </Btn>

            <Btn
              variant="secondary"
              size="sm"
              className="justify-center"
              onClick={exportOrders}
            >
              OS CSV
            </Btn>

            <Btn
              variant="secondary"
              size="sm"
              className="justify-center"
              onClick={exportFinance}
            >
              Financeiro CSV
            </Btn>
          </div>
        </Card>
      </div>
    </div>
  );
}

// ─── Financeiro ─────────────────────────────────────────────────────────────────
function FinancialPage({
  orders,
  entries,
  onReload,
}: {
  orders: ServiceOrder[];
  entries: FinancialEntry[];
  onReload: () => Promise<void>;
}) {
  const [modal, setModal] = useState<null | "income" | "expense">(null);
  const [search, setSearch] = useState("");
  const [form, setForm] = useState({
    description: "",
    amount: "",
    category: "",
  });
  const [loading, setLoading] = useState(false);

  function parseMoney(value?: string | number | null) {
    return Number(
      String(value || "0")
        .replace(/\./g, "")
        .replace(",", "."),
    );
  }

  function formatDate(date?: string | null) {
    if (!date) return "—";
    return new Date(date).toLocaleDateString("pt-BR");
  }

  const finalizedOrders = orders.filter((o) => o.status === "finalizado");
  const openOrders = orders.filter((o) => o.status !== "finalizado");

  const orderIncome = finalizedOrders.reduce(
    (acc, o) => acc + parseMoney(o.value),
    0,
  );

  const openOrderValue = openOrders.reduce(
    (acc, o) => acc + parseMoney(o.value),
    0,
  );

  const manualIncome = entries
    .filter((e) => e.type === "income")
    .reduce((acc, e) => acc + Number(e.amount || 0), 0);

  const expenses = entries
    .filter((e) => e.type === "expense")
    .reduce((acc, e) => acc + Number(e.amount || 0), 0);

  const totalRevenue = orderIncome + manualIncome;
  const profit = totalRevenue - expenses;
  const averageTicket =
    finalizedOrders.length > 0 ? orderIncome / finalizedOrders.length : 0;

  const now = new Date();
  const currentMonth = now.getMonth();
  const currentYear = now.getFullYear();

  const monthlyOrderIncome = finalizedOrders
    .filter((o) => {
      const d = new Date(o.updated_at || o.created_at);
      return d.getMonth() === currentMonth && d.getFullYear() === currentYear;
    })
    .reduce((acc, o) => acc + parseMoney(o.value), 0);

  const monthlyManualIncome = entries
    .filter((e) => {
      const d = new Date(e.created_at);
      return (
        e.type === "income" &&
        d.getMonth() === currentMonth &&
        d.getFullYear() === currentYear
      );
    })
    .reduce((acc, e) => acc + Number(e.amount || 0), 0);

  const monthlyExpenses = entries
    .filter((e) => {
      const d = new Date(e.created_at);
      return (
        e.type === "expense" &&
        d.getMonth() === currentMonth &&
        d.getFullYear() === currentYear
      );
    })
    .reduce((acc, e) => acc + Number(e.amount || 0), 0);

  const monthlyRevenue = monthlyOrderIncome + monthlyManualIncome;
  const monthlyProfit = monthlyRevenue - monthlyExpenses;

  const expenseRate =
    totalRevenue > 0
      ? Math.min(100, Math.round((expenses / totalRevenue) * 100))
      : 0;

  const profitRate =
    totalRevenue > 0 ? Math.round((profit / totalRevenue) * 100) : 0;

  const incomeEntries = entries.filter((e) => e.type === "income").length;
  const expenseEntries = entries.filter((e) => e.type === "expense").length;

  const filteredEntries = entries
    .filter((entry) => {
      const term = search.trim().toLowerCase();

      return (
        !term ||
        String(entry.description || "")
          .toLowerCase()
          .includes(term) ||
        String(entry.category || "")
          .toLowerCase()
          .includes(term) ||
        String(entry.type || "")
          .toLowerCase()
          .includes(term)
      );
    })
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

  const recentOrdersIncome = finalizedOrders
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
    .slice(0, 4);

  const categories = Object.entries(
    entries.reduce<Record<string, number>>((acc, entry) => {
      const name = entry.category || "Sem categoria";
      acc[name] = (acc[name] || 0) + Number(entry.amount || 0);
      return acc;
    }, {}),
  )
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5);

  const maxCategoryValue = Math.max(...categories.map(([, value]) => value), 1);

  const set =
    (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((p) => ({ ...p, [k]: e.target.value }));

  async function save(e: React.FormEvent) {
    e.preventDefault();

    if (loading) return;
    if (!modal) return;

    setLoading(true);

    try {
      await API.createFinancialEntry({
        description: form.description,
        amount: Number(
          String(form.amount || "0")
            .replace(/\./g, "")
            .replace(",", "."),
        ),
        type: modal,
        category: form.category,
      });

      await onReload();

      setModal(null);
      setForm({
        description: "",
        amount: "",
        category: "",
      });
    } catch (err: any) {
      alert(err.message || "Erro ao salvar movimentação.");
    } finally {
      setLoading(false);
    }
  }

  async function del(id: string) {
    if (!confirm("Deseja excluir esta movimentação?")) return;

    try {
      await API.deleteFinancialEntry(id);
      await onReload();
    } catch (err: any) {
      alert(err.message);
    }
  }

  return (
    <div className="space-y-5">
      <div className="overflow-hidden rounded-3xl border border-red-500/20 bg-gradient-to-br from-red-500/10 via-card to-black/40 p-5 shadow-[0_0_35px_rgba(239,68,68,0.08)]">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="inline-flex rounded-full border border-red-500/20 bg-red-500/10 px-3 py-1 text-xs font-bold uppercase tracking-[0.18em] text-red-300">
              Controle financeiro
            </div>

            <h1 className="mt-4 font-heading text-3xl font-black tracking-tight text-foreground">
              Financeiro
            </h1>

            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Acompanhe faturamento, despesas, lucro, OS finalizadas e
              movimentações manuais da oficina.
            </p>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row">
            <Btn
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setModal("expense")}
            >
              Nova Despesa
            </Btn>

            <Btn
              type="button"
              variant="primary"
              size="sm"
              onClick={() => setModal("income")}
            >
              Nova Receita
            </Btn>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs text-muted-foreground">
                Faturamento total
              </div>
              <div className="mt-2 text-2xl font-bold text-green-500">
                {fmtMoney(totalRevenue)}
              </div>
            </div>
            <DollarSign size={20} className="text-green-500" />
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs text-muted-foreground">Despesas</div>
              <div className="mt-2 text-2xl font-bold text-red-500">
                {fmtMoney(expenses)}
              </div>
            </div>
            <TrendingDown size={20} className="text-red-500" />
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs text-muted-foreground">Lucro</div>
              <div
                className={
                  profit >= 0
                    ? "mt-2 text-2xl font-bold text-green-500"
                    : "mt-2 text-2xl font-bold text-red-500"
                }
              >
                {fmtMoney(profit)}
              </div>
            </div>
            <TrendingUp
              size={20}
              className={profit >= 0 ? "text-green-500" : "text-red-500"}
            />
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs text-muted-foreground">Ticket médio</div>
              <div className="mt-2 text-2xl font-bold text-blue-400">
                {fmtMoney(averageTicket)}
              </div>
            </div>
            <Target size={20} className="text-blue-400" />
          </div>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="p-5 xl:col-span-2">
          <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="font-heading text-lg font-bold text-foreground">
                Resumo do mês
              </h2>
              <p className="text-xs text-muted-foreground">
                Visão rápida do desempenho financeiro atual.
              </p>
            </div>

            <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-bold text-white">
              {new Date().toLocaleDateString("pt-BR", {
                month: "long",
                year: "numeric",
              })}
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-2xl border border-green-500/20 bg-green-500/10 p-4">
              <p className="text-xs text-green-300">Receita do mês</p>
              <p className="mt-2 text-2xl font-bold text-white">
                {fmtMoney(monthlyRevenue)}
              </p>
            </div>

            <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-4">
              <p className="text-xs text-red-300">Despesas do mês</p>
              <p className="mt-2 text-2xl font-bold text-white">
                {fmtMoney(monthlyExpenses)}
              </p>
            </div>

            <div className="rounded-2xl border border-blue-500/20 bg-blue-500/10 p-4">
              <p className="text-xs text-blue-300">Lucro do mês</p>
              <p className="mt-2 text-2xl font-bold text-white">
                {fmtMoney(monthlyProfit)}
              </p>
            </div>
          </div>

          <div className="mt-5 grid gap-3 md:grid-cols-2">
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
              <div className="mb-2 flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Peso das despesas</span>
                <span className="font-bold text-foreground">
                  {expenseRate}%
                </span>
              </div>

              <div className="h-3 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-red-500"
                  style={{ width: `${expenseRate}%` }}
                />
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
              <div className="mb-2 flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Margem estimada</span>
                <span
                  className={
                    profitRate >= 0
                      ? "font-bold text-green-400"
                      : "font-bold text-red-400"
                  }
                >
                  {profitRate}%
                </span>
              </div>

              <div className="h-3 overflow-hidden rounded-full bg-white/10">
                <div
                  className={
                    profitRate >= 0
                      ? "h-full rounded-full bg-green-500"
                      : "h-full rounded-full bg-red-500"
                  }
                  style={{ width: `${Math.min(Math.abs(profitRate), 100)}%` }}
                />
              </div>
            </div>
          </div>
        </Card>

        <Card className="p-5">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="font-heading text-lg font-bold text-foreground">
                Saúde financeira
              </h2>
              <p className="text-xs text-muted-foreground">
                Indicadores simples da oficina.
              </p>
            </div>
            <DollarSign size={20} className="text-primary" />
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
              <span className="text-sm text-muted-foreground">
                OS finalizadas
              </span>
              <span className="font-bold text-emerald-400">
                {finalizedOrders.length}
              </span>
            </div>

            <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
              <span className="text-sm text-muted-foreground">
                Receitas manuais
              </span>
              <span className="font-bold text-green-400">{incomeEntries}</span>
            </div>

            <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
              <span className="text-sm text-muted-foreground">
                Despesas manuais
              </span>
              <span className="font-bold text-red-400">{expenseEntries}</span>
            </div>

            <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
              <span className="text-sm text-muted-foreground">
                Em aberto nas OS
              </span>
              <span className="font-bold text-amber-400">
                {fmtMoney(openOrderValue)}
              </span>
            </div>
          </div>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="p-5 xl:col-span-2">
          <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="font-heading text-lg font-bold text-foreground">
                Movimentações
              </h2>
              <p className="text-xs text-muted-foreground">
                {filteredEntries.length} registro(s) encontrado(s).
              </p>
            </div>

            <div className="relative w-full md:max-w-sm">
              <Search
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              />

              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar descrição ou categoria..."
                className="w-full rounded-xl border border-border bg-input-background py-2.5 pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          </div>

          {entries.length === 0 ? (
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-8 text-center">
              <DollarSign
                size={30}
                className="mx-auto mb-2 text-muted-foreground/20"
              />

              <p className="text-sm text-muted-foreground">
                Nenhuma movimentação cadastrada.
              </p>
            </div>
          ) : filteredEntries.length === 0 ? (
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-8 text-center">
              <p className="text-sm text-muted-foreground">
                Nenhuma movimentação encontrada nessa busca.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredEntries.map((entry) => (
                <div
                  key={entry.id}
                  className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 transition hover:border-red-500/20 hover:bg-white/[0.05]"
                >
                  <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={
                            entry.type === "income"
                              ? "rounded-full border border-green-500/20 bg-green-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-green-300"
                              : "rounded-full border border-red-500/20 bg-red-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-red-300"
                          }
                        >
                          {entry.type === "income" ? "Receita" : "Despesa"}
                        </span>

                        <p className="text-sm font-bold text-foreground">
                          {entry.description}
                        </p>
                      </div>

                      <p className="mt-2 text-xs text-muted-foreground">
                        {entry.category || "Sem categoria"} ·{" "}
                        {formatDate(entry.created_at)}
                      </p>
                    </div>

                    <div className="flex items-center gap-3 md:justify-end">
                      <div
                        className={
                          entry.type === "income"
                            ? "text-lg font-bold text-green-500"
                            : "text-lg font-bold text-red-500"
                        }
                      >
                        {entry.type === "income" ? "+" : "-"}{" "}
                        {fmtMoney(Number(entry.amount || 0))}
                      </div>

                      <button
                        type="button"
                        onClick={() => del(entry.id)}
                        className="rounded-xl border border-red-500/20 bg-red-500/10 p-2 text-red-300 transition hover:bg-red-500/20"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <div className="space-y-4">
          <Card className="p-5">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="font-heading text-lg font-bold text-foreground">
                  Categorias
                </h2>
                <p className="text-xs text-muted-foreground">
                  Maiores movimentações manuais.
                </p>
              </div>
              <TrendingUp size={20} className="text-primary" />
            </div>

            {categories.length === 0 ? (
              <p className="rounded-xl border border-white/10 bg-white/[0.03] p-4 text-sm text-muted-foreground">
                As categorias aparecerão após cadastrar movimentações.
              </p>
            ) : (
              <div className="space-y-4">
                {categories.map(([category, value]) => (
                  <div key={category}>
                    <div className="mb-2 flex items-center justify-between text-sm">
                      <span className="font-semibold text-foreground">
                        {category}
                      </span>
                      <span className="text-muted-foreground">
                        {fmtMoney(value)}
                      </span>
                    </div>

                    <div className="h-3 overflow-hidden rounded-full bg-white/10">
                      <div
                        className="h-full rounded-full bg-red-500"
                        style={{
                          width: `${(value / maxCategoryValue) * 100}%`,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card className="p-5">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="font-heading text-lg font-bold text-foreground">
                  Últimas OS recebidas
                </h2>
                <p className="text-xs text-muted-foreground">
                  Receitas vindas de OS finalizadas.
                </p>
              </div>
              <CheckCircle size={20} className="text-primary" />
            </div>

            {recentOrdersIncome.length === 0 ? (
              <p className="rounded-xl border border-white/10 bg-white/[0.03] p-4 text-sm text-muted-foreground">
                Finalize OS com valor para aparecerem aqui.
              </p>
            ) : (
              <div className="space-y-3">
                {recentOrdersIncome.map((order) => (
                  <div
                    key={order.id}
                    className="rounded-xl border border-white/10 bg-white/[0.03] p-4"
                  >
                    <p className="text-sm font-bold text-foreground">
                      OS finalizada
                    </p>

                    <p className="mt-1 text-xs text-muted-foreground">
                      {formatDate(order.updated_at)}
                    </p>

                    <p className="mt-2 text-sm font-bold text-green-500">
                      {fmtMoney(order.value)}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>

      <div className="rounded-3xl border border-red-500/20 bg-red-500/10 p-5">
        <p className="text-sm leading-relaxed text-red-100">
          Dica da Vortan: finalize as ordens de serviço assim que o cliente
          pagar. Isso mantém o faturamento e o lucro da oficina mais próximos da
          realidade.
        </p>
      </div>

      {modal && (
        <Modal
          title={modal === "income" ? "Nova Receita" : "Nova Despesa"}
          onClose={() => setModal(null)}
        >
          <form onSubmit={save} className="flex flex-col gap-4">
            <Textarea
              label="Descrição"
              placeholder={
                modal === "income" ? "Ex: Venda de peça" : "Ex: Compra de óleo"
              }
              value={form.description}
              onChange={(e) =>
                setForm((p) => ({
                  ...p,
                  description: e.target.value,
                }))
              }
              rows={4}
              required
            />

            <Input
              label="Valor"
              placeholder="0,00"
              value={form.amount}
              onChange={set("amount")}
              required
            />

            <Input
              label="Categoria"
              placeholder={
                modal === "income"
                  ? "Ex: Peças, serviços, outros"
                  : "Ex: Peças, aluguel, ferramentas"
              }
              value={form.category}
              onChange={set("category")}
            />

            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
              <p className="text-xs text-muted-foreground">
                Dica: use categorias simples como Peças, Serviços, Aluguel,
                Ferramentas e Outros para facilitar sua leitura financeira.
              </p>
            </div>

            <div className="flex gap-2 pt-1">
              <Btn
                type="button"
                variant="secondary"
                className="flex-1 justify-center"
                onClick={() => setModal(null)}
              >
                Cancelar
              </Btn>

              <Btn
                type="submit"
                variant="primary"
                className="flex-1 justify-center"
                loading={loading}
                disabled={loading}
              >
                {!loading && "Salvar"}
              </Btn>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

// ─── Clients ─────────────────────────────────────────────────────────────────

function ClientsPage({
  clients,
  onReload,
}: {
  clients: Client[];
  onReload: () => Promise<void>;
}) {
  const [search, setSearch] = useState("");
  const [modal, setModal] = useState<null | "add" | Client>(null);
  const [form, setForm] = useState({ name: "", phone: "", whatsapp: "" });
  const [loading, setLoading] = useState(false);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [toast, setToast] = useState<{
    msg: string;
    type: "error" | "success";
  } | null>(null);

  function onlyDigits(value?: string | null) {
    return String(value || "").replace(/\D/g, "");
  }

  function getWhatsAppLink(value?: string | null) {
    const digits = onlyDigits(value);
    if (!digits) return "";
    const number = digits.startsWith("55") ? digits : `55${digits}`;
    return `https://wa.me/${number}`;
  }

  function formatDate(date?: string | null) {
    if (!date) return "—";
    return new Date(date).toLocaleDateString("pt-BR");
  }

  function isCompleteClient(c: Client) {
    return Boolean(c.name && (onlyDigits(c.whatsapp) || onlyDigits(c.phone)));
  }

  const filtered = clients.filter((c) => {
    const term = search.trim().toLowerCase();

    return (
      !term ||
      c.name.toLowerCase().includes(term) ||
      String(c.phone || "")
        .toLowerCase()
        .includes(term) ||
      String(c.whatsapp || "")
        .toLowerCase()
        .includes(term)
    );
  });

  const withWhatsApp = clients.filter((c) => onlyDigits(c.whatsapp)).length;
  const withPhone = clients.filter((c) => onlyDigits(c.phone)).length;
  const incomplete = clients.filter((c) => !isCompleteClient(c)).length;
  const completedRate =
    clients.length > 0
      ? Math.round(((clients.length - incomplete) / clients.length) * 100)
      : 0;

  const recentClients = [...clients]
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 3);

  function showToast(msg: string, type: "error" | "success") {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  }

  function openEdit(c: Client) {
    setForm({ name: c.name, phone: c.phone, whatsapp: c.whatsapp });
    setModal(c);
  }

  function openAdd() {
    setForm({ name: "", phone: "", whatsapp: "" });
    setModal("add");
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();

    if (loading) return;
    if (!modal) return;

    setLoading(true);

    try {
      if (modal === "add") {
        await API.createClient_(form);
      } else if (modal && typeof modal === "object") {
        await API.updateClient(modal.id, form);
      }

      await onReload();
      setModal(null);

      showToast(
        modal === "add" ? "Cliente criado!" : "Cliente atualizado!",
        "success",
      );
    } catch (err: any) {
      showToast(err.message, "error");
    }

    setLoading(false);
  }

  async function del(id: string) {
    try {
      await API.deleteClient(id);
      await onReload();
      setConfirmDel(null);
      showToast("Cliente excluído.", "success");
    } catch (err: any) {
      showToast(err.message, "error");
    }
  }

  const set =
    (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((p) => ({ ...p, [k]: e.target.value }));

  return (
    <div className="space-y-5">
      {toast && <Toast message={toast.msg} type={toast.type} />}

      <div className="overflow-hidden rounded-3xl border border-red-500/20 bg-gradient-to-br from-red-500/10 via-card to-black/40 p-5 shadow-[0_0_35px_rgba(239,68,68,0.08)]">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="inline-flex rounded-full border border-red-500/20 bg-red-500/10 px-3 py-1 text-xs font-bold uppercase tracking-[0.18em] text-red-300">
              CRM da Oficina
            </div>

            <h1 className="mt-4 font-heading text-3xl font-black tracking-tight text-foreground">
              Clientes
            </h1>

            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Organize sua base de clientes, mantenha contatos atualizados e
              encontre informações importantes com mais rapidez.
            </p>
          </div>

          <Btn variant="primary" size="sm" onClick={openAdd}>
            <Plus size={14} /> Novo cliente
          </Btn>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs text-muted-foreground">
                Total de clientes
              </div>
              <div className="mt-2 text-2xl font-bold text-foreground">
                {clients.length}
              </div>
            </div>
            <Users size={20} className="text-primary" />
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs text-muted-foreground">Com WhatsApp</div>
              <div className="mt-2 text-2xl font-bold text-green-500">
                {withWhatsApp}
              </div>
            </div>
            <MessageCircle size={20} className="text-green-500" />
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs text-muted-foreground">Com telefone</div>
              <div className="mt-2 text-2xl font-bold text-blue-400">
                {withPhone}
              </div>
            </div>
            <Phone size={20} className="text-blue-400" />
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs text-muted-foreground">
                Cadastro completo
              </div>
              <div className="mt-2 text-2xl font-bold text-red-400">
                {completedRate}%
              </div>
            </div>
            <CheckCircle size={20} className="text-red-400" />
          </div>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="p-5 xl:col-span-2">
          <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="font-heading text-lg font-bold text-foreground">
                Base de clientes
              </h2>
              <p className="text-xs text-muted-foreground">
                {filtered.length} resultado(s) encontrado(s).
              </p>
            </div>

            <div className="relative w-full md:max-w-sm">
              <Search
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              />

              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar por nome, telefone ou WhatsApp..."
                className="w-full rounded-xl border border-border bg-input-background py-2.5 pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          </div>

          {filtered.length === 0 ? (
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] py-14 text-center">
              <Users
                size={30}
                className="mx-auto mb-2 text-muted-foreground/20"
              />
              <p className="text-sm text-muted-foreground">
                {search ? "Nenhum resultado." : "Nenhum cliente cadastrado."}
              </p>

              {!search && (
                <Btn
                  variant="primary"
                  size="sm"
                  className="mx-auto mt-3"
                  onClick={openAdd}
                >
                  <Plus size={13} /> Adicionar cliente
                </Btn>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {filtered.map((c) => {
                const whatsappLink = getWhatsAppLink(c.whatsapp || c.phone);
                const complete = isCompleteClient(c);

                return (
                  <div
                    key={c.id}
                    className="group rounded-2xl border border-white/10 bg-white/[0.03] p-4 transition hover:border-red-500/20 hover:bg-white/[0.05]"
                  >
                    <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                      <div className="flex min-w-0 items-start gap-3">
                        <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-2xl border border-primary/20 bg-primary/15">
                          <span className="font-heading text-sm font-bold text-primary">
                            {c.name.charAt(0).toUpperCase()}
                          </span>
                        </div>

                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="truncate text-sm font-bold text-foreground">
                              {c.name}
                            </p>

                            {complete ? (
                              <span className="rounded-full border border-green-500/20 bg-green-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-green-300">
                                Completo
                              </span>
                            ) : (
                              <span className="rounded-full border border-yellow-500/20 bg-yellow-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-yellow-300">
                                Revisar
                              </span>
                            )}
                          </div>

                          <div className="mt-2 flex flex-wrap items-center gap-3">
                            {c.phone ? (
                              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                                <Phone size={11} />
                                {c.phone}
                              </span>
                            ) : (
                              <span className="text-xs text-muted-foreground">
                                Sem telefone
                              </span>
                            )}

                            {c.whatsapp ? (
                              <span className="flex items-center gap-1 text-xs text-red-400">
                                <MessageCircle size={11} />
                                {c.whatsapp}
                              </span>
                            ) : (
                              <span className="text-xs text-muted-foreground">
                                Sem WhatsApp
                              </span>
                            )}

                            <span className="text-xs text-muted-foreground">
                              Criado em {formatDate(c.created_at)}
                            </span>
                          </div>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 md:justify-end">
                        {whatsappLink && (
                          <a
                            href={whatsappLink}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-2 rounded-xl border border-green-500/20 bg-green-500/10 px-3 py-2 text-xs font-bold text-green-300 transition hover:bg-green-500/20"
                          >
                            <MessageCircle size={13} />
                            WhatsApp
                          </a>
                        )}

                        <button
                          onClick={() => openEdit(c)}
                          className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-bold text-white transition hover:bg-white/10"
                        >
                          <Edit2 size={13} />
                          Editar
                        </button>

                        <button
                          onClick={() => setConfirmDel(c.id)}
                          className="inline-flex items-center gap-2 rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs font-bold text-red-300 transition hover:bg-red-500/20"
                        >
                          <Trash2 size={13} />
                          Excluir
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        <div className="space-y-4">
          <Card className="p-5">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="font-heading text-lg font-bold text-foreground">
                  Últimos cadastros
                </h2>
                <p className="text-xs text-muted-foreground">
                  Clientes adicionados recentemente.
                </p>
              </div>
              <Users size={20} className="text-primary" />
            </div>

            {recentClients.length === 0 ? (
              <p className="rounded-xl border border-white/10 bg-white/[0.03] p-4 text-sm text-muted-foreground">
                Nenhum cliente cadastrado ainda.
              </p>
            ) : (
              <div className="space-y-3">
                {recentClients.map((client) => (
                  <div
                    key={client.id}
                    className="rounded-xl border border-white/10 bg-white/[0.03] p-4"
                  >
                    <p className="text-sm font-bold text-foreground">
                      {client.name}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {formatDate(client.created_at)}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>

      {modal && (
        <Modal
          title={modal === "add" ? "Novo Cliente" : "Editar Cliente"}
          onClose={() => setModal(null)}
        >
          <form onSubmit={save} className="flex flex-col gap-4">
            <Input
              label="Nome completo"
              placeholder="Maria Aparecida"
              value={form.name}
              onChange={set("name")}
              required
            />

            <Input
              label="Telefone"
              placeholder="(11) 98765-4321"
              value={form.phone}
              onChange={set("phone")}
            />

            <Input
              label="WhatsApp"
              placeholder="(11) 98765-4321"
              value={form.whatsapp}
              onChange={set("whatsapp")}
            />

            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
              <p className="text-xs text-muted-foreground">
                Dica: se o WhatsApp for igual ao telefone, você pode repetir o
                número nos dois campos para facilitar o contato rápido.
              </p>
            </div>

            <div className="flex gap-2 pt-1">
              <Btn
                type="button"
                variant="secondary"
                className="flex-1 justify-center"
                onClick={() => setModal(null)}
              >
                Cancelar
              </Btn>

              <Btn
                type="submit"
                variant="primary"
                className="flex-1 justify-center"
                loading={loading}
              >
                {!loading && "Salvar"}
              </Btn>
            </div>
          </form>
        </Modal>
      )}

      {confirmDel && (
        <Modal title="Excluir cliente?" onClose={() => setConfirmDel(null)}>
          <p className="mb-4 text-sm text-muted-foreground">
            Esta ação não pode ser desfeita. Todos os veículos e ordens
            vinculados também serão excluídos.
          </p>

          <div className="flex gap-2">
            <Btn
              variant="secondary"
              className="flex-1 justify-center"
              onClick={() => setConfirmDel(null)}
            >
              Cancelar
            </Btn>

            <Btn
              variant="danger"
              className="flex-1 justify-center"
              onClick={() => del(confirmDel)}
            >
              <Trash2 size={13} /> Excluir
            </Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── Vehicles ─────────────────────────────────────────────────────────────────

function VehiclesPage({
  vehicles,
  clients,
  onReload,
}: {
  vehicles: Vehicle[];
  clients: Client[];
  onReload: () => Promise<void>;
}) {
  const [search, setSearch] = useState("");
  const [modal, setModal] = useState<null | "add" | Vehicle>(null);
  const [form, setForm] = useState({
    client_id: "",
    plate: "",
    brand: "",
    model: "",
    year: "",
    mileage: "",
  });
  const [loading, setLoading] = useState(false);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [toast, setToast] = useState<{
    msg: string;
    type: "error" | "success";
  } | null>(null);

  function formatDate(date?: string | null) {
    if (!date) return "—";
    return new Date(date).toLocaleDateString("pt-BR");
  }

  function formatKm(value?: string | number | null) {
    const n = Number(String(value || "0").replace(/\D/g, ""));
    if (!n) return "—";
    return `${n.toLocaleString("pt-BR")} km`;
  }

  function normalizePlate(value?: string | null) {
    return String(value || "")
      .trim()
      .toUpperCase();
  }

  function getClientName(clientId: string) {
    return (
      clients.find((c) => c.id === clientId)?.name || "Cliente não informado"
    );
  }

  const filtered = vehicles.filter((v) => {
    const term = search.trim().toLowerCase();
    const client = clients.find((c) => c.id === v.client_id);

    return (
      !term ||
      String(v.plate || "")
        .toLowerCase()
        .includes(term) ||
      String(v.model || "")
        .toLowerCase()
        .includes(term) ||
      String(v.brand || "")
        .toLowerCase()
        .includes(term) ||
      String(v.year || "")
        .toLowerCase()
        .includes(term) ||
      String(client?.name || "")
        .toLowerCase()
        .includes(term)
    );
  });

  const brands = Array.from(
    new Set(
      vehicles
        .map((v) => String(v.brand || "").trim())
        .filter(Boolean)
        .map((brand) => brand.toLowerCase()),
    ),
  );

  const vehiclesWithKm = vehicles.filter(
    (v) => Number(String(v.mileage || "0").replace(/\D/g, "")) > 0,
  );

  const averageKm =
    vehiclesWithKm.length > 0
      ? Math.round(
          vehiclesWithKm.reduce(
            (acc, v) =>
              acc + Number(String(v.mileage || "0").replace(/\D/g, "")),
            0,
          ) / vehiclesWithKm.length,
        )
      : 0;

  const clientsWithVehicles = new Set(vehicles.map((v) => v.client_id)).size;
  const withoutMileage = vehicles.filter(
    (v) => !Number(String(v.mileage || "0").replace(/\D/g, "")),
  ).length;

  const recentVehicles = [...vehicles]
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 3);

  const topBrands = Object.entries(
    vehicles.reduce<Record<string, number>>((acc, vehicle) => {
      const brand = String(vehicle.brand || "Sem marca").trim() || "Sem marca";
      acc[brand] = (acc[brand] || 0) + 1;
      return acc;
    }, {}),
  )
    .sort(([, a], [, b]) => b - a)
    .slice(0, 4);

  function showToast(msg: string, type: "error" | "success") {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  }

  function openAdd() {
    setForm({
      client_id: clients[0]?.id ?? "",
      plate: "",
      brand: "",
      model: "",
      year: "",
      mileage: "",
    });
    setModal("add");
  }

  function openEdit(v: Vehicle) {
    setForm({
      client_id: v.client_id,
      plate: v.plate,
      brand: v.brand,
      model: v.model,
      year: v.year,
      mileage: v.mileage,
    });
    setModal(v);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();

    if (loading) return;
    if (!modal) return;

    setLoading(true);

    try {
      const payload = {
        ...form,
        plate: normalizePlate(form.plate),
      };

      if (modal === "add") {
        await API.createVehicle(payload);
      } else if (modal && typeof modal === "object") {
        await API.updateVehicle(modal.id, payload);
      }

      await onReload();
      setModal(null);

      showToast(
        modal === "add" ? "Veículo cadastrado!" : "Veículo atualizado!",
        "success",
      );
    } catch (err: any) {
      showToast(err.message, "error");
    }

    setLoading(false);
  }

  async function del(id: string) {
    try {
      await API.deleteVehicle(id);
      await onReload();
      setConfirmDel(null);
      showToast("Veículo excluído.", "success");
    } catch (err: any) {
      showToast(err.message, "error");
    }
  }

  const set =
    (k: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm((p) => ({ ...p, [k]: e.target.value }));

  return (
    <div className="space-y-5">
      {toast && <Toast message={toast.msg} type={toast.type} />}

      <div className="overflow-hidden rounded-3xl border border-red-500/20 bg-gradient-to-br from-red-500/10 via-card to-black/40 p-5 shadow-[0_0_35px_rgba(239,68,68,0.08)]">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="inline-flex rounded-full border border-red-500/20 bg-red-500/10 px-3 py-1 text-xs font-bold uppercase tracking-[0.18em] text-red-300">
              Garagem da Oficina
            </div>

            <h1 className="mt-4 font-heading text-3xl font-black tracking-tight text-foreground">
              Veículos
            </h1>

            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Controle os veículos dos clientes com placa, modelo, proprietário,
              quilometragem e informações úteis para atendimento.
            </p>
          </div>

          <Btn
            variant="primary"
            size="sm"
            onClick={openAdd}
            disabled={clients.length === 0}
          >
            <Plus size={14} /> Novo veículo
          </Btn>
        </div>
      </div>

      {clients.length === 0 && (
        <div className="flex items-center gap-2 rounded-2xl border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-sm text-amber-300">
          <AlertCircle size={14} /> Cadastre um cliente antes de adicionar
          veículos.
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs text-muted-foreground">
                Total de veículos
              </div>
              <div className="mt-2 text-2xl font-bold text-foreground">
                {vehicles.length}
              </div>
            </div>
            <Car size={20} className="text-primary" />
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs text-muted-foreground">
                Quilometragem média
              </div>
              <div className="mt-2 text-2xl font-bold text-blue-400">
                {averageKm ? formatKm(averageKm) : "—"}
              </div>
            </div>
            <Gauge size={20} className="text-blue-400" />
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs text-muted-foreground">
                Marcas cadastradas
              </div>
              <div className="mt-2 text-2xl font-bold text-red-400">
                {brands.length}
              </div>
            </div>
            <Building2 size={20} className="text-red-400" />
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs text-muted-foreground">
                Clientes com veículos
              </div>
              <div className="mt-2 text-2xl font-bold text-green-500">
                {clientsWithVehicles}
              </div>
            </div>
            <Users size={20} className="text-green-500" />
          </div>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="p-5 xl:col-span-2">
          <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="font-heading text-lg font-bold text-foreground">
                Garagem cadastrada
              </h2>
              <p className="text-xs text-muted-foreground">
                {filtered.length} resultado(s) encontrado(s).
              </p>
            </div>

            <div className="relative w-full md:max-w-sm">
              <Search
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              />

              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar placa, modelo, marca ou cliente..."
                className="w-full rounded-xl border border-border bg-input-background py-2.5 pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          </div>

          {filtered.length === 0 ? (
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] py-14 text-center">
              <Car
                size={30}
                className="mx-auto mb-2 text-muted-foreground/20"
              />

              <p className="text-sm text-muted-foreground">
                {search ? "Nenhum resultado." : "Nenhum veículo cadastrado."}
              </p>

              {!search && clients.length > 0 && (
                <Btn
                  variant="primary"
                  size="sm"
                  className="mx-auto mt-3"
                  onClick={openAdd}
                >
                  <Plus size={13} /> Adicionar veículo
                </Btn>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {filtered.map((v) => {
                const client = clients.find((c) => c.id === v.client_id);
                const hasMileage =
                  Number(String(v.mileage || "0").replace(/\D/g, "")) > 0;

                return (
                  <div
                    key={v.id}
                    className="group rounded-2xl border border-white/10 bg-white/[0.03] p-4 transition hover:border-red-500/20 hover:bg-white/[0.05]"
                  >
                    <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                      <div className="flex min-w-0 items-start gap-3">
                        <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-2xl border border-blue-400/20 bg-blue-400/10">
                          <Car size={18} className="text-blue-400" />
                        </div>

                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="truncate text-sm font-bold text-foreground">
                              {v.brand || "Sem marca"} {v.model || "Sem modelo"}
                            </p>

                            <span className="rounded-full border border-red-500/25 bg-red-500/10 px-3 py-1 font-mono text-xs font-bold uppercase tracking-wider text-red-300">
                              {normalizePlate(v.plate) || "Sem placa"}
                            </span>

                            {!hasMileage && (
                              <span className="rounded-full border border-yellow-500/20 bg-yellow-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-yellow-300">
                                Sem km
                              </span>
                            )}
                          </div>

                          <div className="mt-2 flex flex-wrap items-center gap-3">
                            {v.year && (
                              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                                <Calendar size={11} />
                                {v.year}
                              </span>
                            )}

                            <span className="flex items-center gap-1 text-xs text-muted-foreground">
                              <Gauge size={11} />
                              {formatKm(v.mileage)}
                            </span>

                            <span className="flex items-center gap-1 text-xs text-muted-foreground">
                              <Users size={11} />
                              {client?.name || "Cliente não informado"}
                            </span>

                            <span className="text-xs text-muted-foreground">
                              Criado em {formatDate(v.created_at)}
                            </span>
                          </div>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 md:justify-end">
                        <button
                          onClick={() => openEdit(v)}
                          className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-bold text-white transition hover:bg-white/10"
                        >
                          <Edit2 size={13} />
                          Editar
                        </button>

                        <button
                          onClick={() => setConfirmDel(v.id)}
                          className="inline-flex items-center gap-2 rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs font-bold text-red-300 transition hover:bg-red-500/20"
                        >
                          <Trash2 size={13} />
                          Excluir
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        <div className="space-y-4">
          <Card className="p-5">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="font-heading text-lg font-bold text-foreground">
                  Marcas mais comuns
                </h2>
                <p className="text-xs text-muted-foreground">
                  Distribuição da garagem.
                </p>
              </div>
              <BarChart3 size={20} className="text-primary" />
            </div>

            {topBrands.length === 0 ? (
              <p className="rounded-xl border border-white/10 bg-white/[0.03] p-4 text-sm text-muted-foreground">
                As marcas aparecerão aqui após cadastrar veículos.
              </p>
            ) : (
              <div className="space-y-3">
                {topBrands.map(([brand, count]) => (
                  <div key={brand}>
                    <div className="mb-2 flex items-center justify-between text-sm">
                      <span className="font-semibold text-foreground">
                        {brand}
                      </span>
                      <span className="text-muted-foreground">
                        {count} veículo(s)
                      </span>
                    </div>

                    <div className="h-3 overflow-hidden rounded-full bg-white/10">
                      <div
                        className="h-full rounded-full bg-red-500"
                        style={{
                          width: `${Math.min(
                            100,
                            (count / Math.max(vehicles.length, 1)) * 100,
                          )}%`,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card className="p-5">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="font-heading text-lg font-bold text-foreground">
                  Últimos veículos
                </h2>
                <p className="text-xs text-muted-foreground">
                  Cadastrados recentemente.
                </p>
              </div>
              <Car size={20} className="text-primary" />
            </div>

            {recentVehicles.length === 0 ? (
              <p className="rounded-xl border border-white/10 bg-white/[0.03] p-4 text-sm text-muted-foreground">
                Nenhum veículo cadastrado ainda.
              </p>
            ) : (
              <div className="space-y-3">
                {recentVehicles.map((vehicle) => (
                  <div
                    key={vehicle.id}
                    className="rounded-xl border border-white/10 bg-white/[0.03] p-4"
                  >
                    <p className="text-sm font-bold text-foreground">
                      {vehicle.brand || "Sem marca"}{" "}
                      {vehicle.model || "Sem modelo"}
                    </p>

                    <p className="mt-1 font-mono text-xs text-red-300">
                      {normalizePlate(vehicle.plate) || "Sem placa"}
                    </p>

                    <p className="mt-1 text-xs text-muted-foreground">
                      {getClientName(vehicle.client_id)}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>

      {modal && (
        <Modal
          title={modal === "add" ? "Novo Veículo" : "Editar Veículo"}
          onClose={() => setModal(null)}
        >
          <form onSubmit={save} className="flex flex-col gap-4">
            <Select
              label="Cliente"
              value={form.client_id}
              onChange={set("client_id")}
              required
            >
              <option value="">Selecione o cliente...</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>

            <Input
              label="Placa"
              placeholder="ABC-1234"
              value={form.plate}
              onChange={set("plate")}
              required
              className="uppercase"
            />

            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Marca"
                placeholder="Toyota"
                value={form.brand}
                onChange={set("brand")}
              />

              <Input
                label="Modelo"
                placeholder="Corolla"
                value={form.model}
                onChange={set("model")}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Ano"
                placeholder="2021"
                type="number"
                value={form.year}
                onChange={set("year")}
              />

              <Input
                label="Quilometragem"
                placeholder="45000"
                type="number"
                value={form.mileage}
                onChange={set("mileage")}
              />
            </div>

            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
              <p className="text-xs text-muted-foreground">
                Dica: manter a quilometragem atualizada ajuda a oficina a
                recomendar futuras revisões com mais precisão.
              </p>
            </div>

            <div className="flex gap-2 pt-1">
              <Btn
                type="button"
                variant="secondary"
                className="flex-1 justify-center"
                onClick={() => setModal(null)}
              >
                Cancelar
              </Btn>

              <Btn
                type="submit"
                variant="primary"
                className="flex-1 justify-center"
                loading={loading}
              >
                {!loading && "Salvar"}
              </Btn>
            </div>
          </form>
        </Modal>
      )}

      {confirmDel && (
        <Modal title="Excluir veículo?" onClose={() => setConfirmDel(null)}>
          <p className="mb-4 text-sm text-muted-foreground">
            Esta ação não pode ser desfeita.
          </p>

          <div className="flex gap-2">
            <Btn
              variant="secondary"
              className="flex-1 justify-center"
              onClick={() => setConfirmDel(null)}
            >
              Cancelar
            </Btn>

            <Btn
              variant="danger"
              className="flex-1 justify-center"
              onClick={() => del(confirmDel)}
            >
              <Trash2 size={13} /> Excluir
            </Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── Orders ───────────────────────────────────────────────────────────────────

function BudgetsPage({
  profile,
  orders,
  clients,
  vehicles,
  onReload,
}: {
  profile: Profile | null;
  orders: ServiceOrder[];
  clients: Client[];
  vehicles: Vehicle[];
  onReload: () => Promise<void>;
}) {
  const [search, setSearch] = useState("");
  const [modal, setModal] = useState(false);
  const [loading, setLoading] = useState(false);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [toast, setToast] = useState<{
    msg: string;
    type: "error" | "success";
  } | null>(null);
  const [form, setForm] = useState({
    client_id: "",
    vehicle_id: "",
    reported_issue: "",
    employee_name: "",
    services_performed: "",
    value: "",
    payment_method: "PIX",
    payment_details: "",
    validity: "15 dias",
    custom_validity: "",
    client_note: "",
    internal_note: "",
    parts: [{ description: "", value: "" }] as BudgetItem[],
    labor: [{ description: "", value: "" }] as BudgetItem[],
  });

  function showToast(msg: string, type: "error" | "success") {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  }

  function parseMoney(value?: string | number | null) {
    return Number(
      String(value || "0")
        .replace(/\./g, "")
        .replace(",", "."),
    );
  }

  function formatDate(date?: string | null) {
    if (!date) return "—";
    return new Date(date).toLocaleDateString("pt-BR");
  }

  function getClient(order: ServiceOrder) {
    return clients.find((c) => c.id === order.client_id);
  }

  function getVehicle(order: ServiceOrder) {
    return vehicles.find((v) => v.id === order.vehicle_id);
  }

  const clientVehicles = vehicles.filter((v) => v.client_id === form.client_id);
  const totalValue = orders.reduce(
    (acc, order) => acc + parseMoney(order.value),
    0,
  );

  const filtered = orders.filter((order) => {
    const term = search.trim().toLowerCase();
    if (!term) return true;
    const client = getClient(order);
    const vehicle = getVehicle(order);
    return (
      String(client?.name || "")
        .toLowerCase()
        .includes(term) ||
      String(vehicle?.plate || "")
        .toLowerCase()
        .includes(term) ||
      String(vehicle?.brand || "")
        .toLowerCase()
        .includes(term) ||
      String(vehicle?.model || "")
        .toLowerCase()
        .includes(term) ||
      String(order.reported_issue || "")
        .toLowerCase()
        .includes(term) ||
      String(order.services_performed || "")
        .toLowerCase()
        .includes(term)
    );
  });

  const sorted = [...filtered].sort((a, b) =>
    String(b.updated_at || b.created_at).localeCompare(
      String(a.updated_at || a.created_at),
    ),
  );

  function openAdd() {
    const firstClient = clients[0];
    const firstVehicle = firstClient
      ? vehicles.find((v) => v.client_id === firstClient.id)
      : null;
    setForm({
      client_id: firstClient?.id ?? "",
      vehicle_id: firstVehicle?.id ?? "",
      reported_issue: "",
      employee_name: "",
      services_performed: "",
      value: "",
      payment_method: "PIX",
      payment_details: "",
      validity: "15 dias",
      custom_validity: "",
      client_note: "",
      internal_note: "",
      parts: [{ description: "", value: "" }],
      labor: [{ description: "", value: "" }],
    });
    setModal(true);
  }

  const set =
    (k: keyof typeof form) =>
    (
      e: React.ChangeEvent<
        HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      >,
    ) => {
      const val = e.target.value;
      setForm((p) => {
        const next = { ...p, [k]: val };
        if (k === "client_id") {
          const veh = vehicles.find((v) => v.client_id === val);
          next.vehicle_id = veh?.id ?? "";
        }
        return next;
      });
    };

  function updateBudgetItem(
    kind: "parts" | "labor",
    index: number,
    field: keyof BudgetItem,
    value: string,
  ) {
    setForm((p) => ({
      ...p,
      [kind]: p[kind].map((item, i) =>
        i === index ? { ...item, [field]: value } : item,
      ),
    }));
  }

  function addBudgetItem(kind: "parts" | "labor") {
    setForm((p) => ({
      ...p,
      [kind]: [...p[kind], { description: "", value: "" }],
    }));
  }

  function removeBudgetItem(kind: "parts" | "labor", index: number) {
    setForm((p) => ({
      ...p,
      [kind]:
        p[kind].length <= 1
          ? [{ description: "", value: "" }]
          : p[kind].filter((_, i) => i !== index),
    }));
  }

  function sumBudgetItems(items?: BudgetItem[]) {
    return (items ?? []).reduce(
      (acc, item) => acc + parseMoney(item?.value ?? 0),
      0,
    );
  }

  function cleanBudgetItems(items?: BudgetItem[]) {
    return (items ?? [])
      .map((item) => ({
        description: item.description.trim(),
        value: String(parseMoney(item.value)),
      }))
      .filter((item) => item.description || parseMoney(item.value) > 0);
  }

  const partsTotal = sumBudgetItems(form.parts);
  const laborTotal = sumBudgetItems(form.labor);
  const budgetTotal = partsTotal + laborTotal;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form.client_id) return showToast("Selecione um cliente.", "error");
    if (!form.vehicle_id) return showToast("Selecione um veículo.", "error");
    setLoading(true);
    try {
      const validity =
        form.validity === "Data personalizada"
          ? form.custom_validity || "Data personalizada"
          : form.validity;

      await API.createOrder({
        client_id: form.client_id,
        vehicle_id: form.vehicle_id,
        reported_issue: form.reported_issue,
        employee_name: form.employee_name,
        services_performed: cleanBudgetItems(form.labor)
          .map((item) => item.description)
          .join("\n"),
        status: "aguardando",
        value: String(budgetTotal),
        notes: buildBudgetNotes({
          payment_method: form.payment_method,
          payment_details: form.payment_details,
          validity,
          client_note: form.client_note,
          internal_note: form.internal_note,
          parts: cleanBudgetItems(form.parts),
          labor: cleanBudgetItems(form.labor),
        }),
      } as any);
      await onReload();
      setModal(false);
      showToast("Orçamento criado!", "success");
    } catch (err: any) {
      showToast(err.message || "Erro ao criar orçamento.", "error");
    } finally {
      setLoading(false);
    }
  }

  async function convertToOrder(order: ServiceOrder) {
    try {
      await API.updateOrder(order.id, {
        notes: cleanBudgetNotes(order.notes),
        status: "aguardando",
      });
      await onReload();
      showToast("Orçamento convertido em O.S.!", "success");
    } catch (err: any) {
      showToast(err.message || "Erro ao converter orçamento.", "error");
    }
  }

  async function del(id: string) {
    try {
      await API.deleteOrder(id);
      await onReload();
      setConfirmDel(null);
      showToast("Orçamento excluído.", "success");
    } catch (err: any) {
      showToast(err.message || "Erro ao excluir orçamento.", "error");
    }
  }

  async function generateBudget(order: ServiceOrder) {
    const client = getClient(order);
    const vehicle = getVehicle(order);

    if (!client || !vehicle || !profile) {
      showToast("Não foi possível gerar o PDF. Dados incompletos.", "error");
      return;
    }

    await generateBudgetPDF({
      order: {
        ...order,
        delivery_date: (order as any).delivery_date || undefined,
      },
      client,
      vehicle,
      workshop: {
        workshop_name: profile.workshop_name || undefined,
        owner_name: profile.owner_name || undefined,
        phone: profile.phone || undefined,
        whatsapp: profile.whatsapp || undefined,
        city: profile.city || undefined,
        state: profile.state || undefined,
        logo_url: profile.logo_url || undefined,
      },
      details: getBudgetDetails(order.notes),
    });
  }

  async function sendBudgetWhatsApp(order: ServiceOrder) {
    const client = getClient(order);
    const vehicle = getVehicle(order);
    const num = (client?.whatsapp || client?.phone || "").replace(/\D/g, "");

    if (!client || !vehicle) {
      showToast("Cliente ou veículo não encontrado.", "error");
      return;
    }

    if (!num) {
      showToast("Cliente sem WhatsApp cadastrado.", "error");
      return;
    }

    await generateBudget(order);

    const details = getBudgetDetails(order.notes);
    const payment =
      `${details.payment_method || ""}${details.payment_details ? ` • ${details.payment_details}` : ""}`.trim();
    const signature = `${profile?.workshop_name || "Oficina"}${profile?.whatsapp || profile?.phone ? `\nTel/WhatsApp: ${profile?.whatsapp || profile?.phone}` : ""}`;
    const message =
      `Olá, ${client.name}.\n\n` +
      `Seu orçamento já está pronto.\n\n` +
      `Veículo: ${vehicle.brand || ""} ${vehicle.model || ""} (${vehicle.plate || "-"})\n` +
      `Valor: ${fmtMoney(order.value)}\n` +
      (payment ? `Pagamento: ${payment}\n` : "") +
      (details.validity ? `Validade: ${details.validity}\n` : "") +
      `\nServiços orçados:\n${order.services_performed || "-"}\n\n` +
      `O PDF do orçamento foi gerado pela oficina para envio ao cliente. Qualquer dúvida, estamos à disposição.\n\n` +
      signature;

    window.open(
      `https://wa.me/55${num}?text=${encodeURIComponent(message)}`,
      "_blank",
    );
  }

  return (
    <div className="space-y-5">
      {toast && <Toast message={toast.msg} type={toast.type} />}

      <div className="overflow-hidden rounded-3xl border border-red-500/20 bg-gradient-to-br from-red-500/10 via-card to-black/40 p-5 shadow-[0_0_35px_rgba(239,68,68,0.08)]">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <div className="inline-flex rounded-full border border-red-500/20 bg-red-500/10 px-3 py-1 text-xs font-bold uppercase tracking-[0.18em] text-red-300">
              Propostas da Oficina
            </div>
            <h1 className="mt-4 font-heading text-3xl font-black tracking-tight text-foreground">
              Orçamentos
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Crie orçamentos separados das Ordens de Serviço e converta em O.S.
              somente quando o cliente aprovar.
            </p>
          </div>
          <Btn
            variant="primary"
            onClick={openAdd}
            disabled={!clients.length || !vehicles.length}
            className="justify-center"
          >
            <Plus size={16} />
            Novo Orçamento
          </Btn>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Card className="p-4">
          <div className="text-xs text-muted-foreground">
            Total de Orçamentos
          </div>
          <div className="mt-2 text-2xl font-bold text-foreground">
            {orders.length}
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted-foreground">Valor orçado</div>
          <div className="mt-2 text-2xl font-bold text-green-500">
            {fmtMoney(totalValue)}
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted-foreground">Fluxo</div>
          <div className="mt-2 text-sm font-bold text-red-300">
            Orçamento → Converter em O.S.
          </div>
        </Card>
      </div>

      {(!clients.length || !vehicles.length) && (
        <div className="flex items-start gap-3 rounded-2xl border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-sm text-amber-200">
          <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
          <div>
            <p className="font-bold">Cadastro incompleto</p>
            <p className="text-xs text-amber-100/80">
              Cadastre pelo menos um cliente e um veículo antes de abrir um
              orçamento.
            </p>
          </div>
        </div>
      )}

      <Card className="p-4">
        <div className="relative w-full xl:max-w-md">
          <Search
            size={15}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar cliente, placa, veículo ou serviço..."
            className="w-full rounded-xl border border-border bg-input-background py-3 pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
      </Card>

      {sorted.length === 0 ? (
        <Card className="py-16 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-red-500/20 bg-red-500/10">
            <FileText size={26} className="text-red-300" />
          </div>
          <h2 className="font-heading text-xl font-bold text-foreground">
            Nenhum orçamento encontrado
          </h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            {search
              ? "Tente buscar por outro cliente, placa ou serviço."
              : "Crie o primeiro orçamento para enviar ao cliente antes de abrir a O.S."}
          </p>
          {!search && (
            <Btn
              type="button"
              variant="primary"
              className="mx-auto mt-5"
              onClick={openAdd}
              disabled={!clients.length || !vehicles.length}
            >
              <Plus size={15} />
              Criar primeiro orçamento
            </Btn>
          )}
        </Card>
      ) : (
        <div className="space-y-3">
          {sorted.map((order) => {
            const client = getClient(order);
            const vehicle = getVehicle(order);
            return (
              <Card
                key={order.id}
                className="group overflow-hidden border-white/10 bg-[#0A0E13]/90 hover:border-red-500/25"
              >
                <div className="flex flex-col gap-4 p-4 xl:flex-row xl:items-center xl:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-red-500/20 bg-red-500/10 text-red-300">
                        <FileText size={18} />
                      </div>
                      <div className="min-w-0">
                        <h2 className="font-heading text-base font-bold text-foreground">
                          {client?.name || "Cliente não informado"}
                        </h2>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {vehicle
                            ? `${vehicle.brand} ${vehicle.model} • ${vehicle.plate}`
                            : "Veículo não informado"}
                        </p>
                      </div>
                    </div>
                    <div className="mt-4 grid gap-3 md:grid-cols-2">
                      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
                        <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                          Solicitação
                        </p>
                        <p className="mt-1 truncate text-sm text-foreground">
                          {order.reported_issue || "Não informado"}
                        </p>
                      </div>
                      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
                        <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                          Serviços orçados
                        </p>
                        <p className="mt-1 truncate text-sm text-foreground">
                          {order.services_performed || "Não informado"}
                        </p>
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-col gap-3 xl:w-72 xl:items-end">
                    <div className="w-full rounded-2xl border border-green-500/20 bg-green-500/10 px-4 py-3 xl:text-right">
                      <p className="text-xs text-muted-foreground">
                        Valor orçado
                      </p>
                      <p className="mt-1 text-2xl font-black text-green-400">
                        {fmtMoney(order.value)}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Criado em {formatDate(order.created_at)}
                      </p>
                    </div>
                    <div className="flex w-full flex-wrap gap-2 xl:justify-end">
                      <button
                        type="button"
                        onClick={() => generateBudget(order)}
                        className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl border border-blue-500/20 bg-blue-500/10 px-3 py-2 text-xs font-bold text-blue-300 transition hover:bg-blue-500/20 xl:flex-none"
                      >
                        <Download size={13} />
                        PDF
                      </button>
                      <button
                        type="button"
                        onClick={() => sendBudgetWhatsApp(order)}
                        className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs font-bold text-emerald-300 transition hover:bg-emerald-500/20 xl:flex-none"
                      >
                        <MessageCircle size={13} />
                        WhatsApp
                      </button>
                      <button
                        type="button"
                        onClick={() => convertToOrder(order)}
                        className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl border border-green-500/20 bg-green-500/10 px-3 py-2 text-xs font-bold text-green-300 transition hover:bg-green-500/20 xl:flex-none"
                      >
                        <CheckCircle size={13} />
                        Converter em O.S.
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDel(order.id)}
                        className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs font-bold text-red-300 transition hover:bg-red-500/20 xl:flex-none"
                      >
                        <Trash2 size={13} />
                        Excluir
                      </button>
                    </div>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {modal && (
        <Modal title="Novo Orçamento" onClose={() => setModal(false)}>
          <form onSubmit={save} className="flex flex-col gap-4">
            <Select
              label="Cliente"
              value={form.client_id}
              onChange={set("client_id")}
              required
            >
              <option value="">Selecione um cliente</option>
              {clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </Select>
            <Select
              label="Veículo"
              value={form.vehicle_id}
              onChange={set("vehicle_id")}
              required
            >
              <option value="">Selecione um veículo</option>
              {clientVehicles.map((vehicle) => (
                <option key={vehicle.id} value={vehicle.id}>
                  {vehicle.brand} {vehicle.model} • {vehicle.plate}
                </option>
              ))}
            </Select>
            <Textarea
              label="Solicitação do cliente"
              placeholder="Ex: Revisar suspensão e freios..."
              value={form.reported_issue}
              onChange={set("reported_issue")}
              required
              rows={3}
            />
            <Input
              label="Funcionário responsável"
              placeholder="Ex: João"
              value={form.employee_name}
              onChange={set("employee_name")}
            />

            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-sm font-bold text-foreground">
                  <Wrench size={15} className="text-red-300" />
                  Peças
                </div>
                <button
                  type="button"
                  onClick={() => addBudgetItem("parts")}
                  className="inline-flex items-center gap-1 rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs font-bold text-red-200 hover:bg-red-500/20"
                >
                  <Plus size={13} />
                  Adicionar peça
                </button>
              </div>
              <div className="space-y-2">
                {form.parts.map((item, index) => (
                  <div
                    key={`part-${index}`}
                    className="grid gap-2 rounded-xl border border-white/10 bg-black/20 p-3 md:grid-cols-[1fr_160px_38px]"
                  >
                    <Input
                      label="Peça"
                      placeholder="Ex: Pastilha de freio"
                      value={item.description}
                      onChange={(e) =>
                        updateBudgetItem(
                          "parts",
                          index,
                          "description",
                          e.target.value,
                        )
                      }
                    />
                    <Input
                      label="Valor R$"
                      placeholder="Ex: 180,00"
                      value={item.value}
                      onChange={(e) =>
                        updateBudgetItem(
                          "parts",
                          index,
                          "value",
                          e.target.value,
                        )
                      }
                    />
                    <button
                      type="button"
                      onClick={() => removeBudgetItem("parts", index)}
                      className="mt-6 inline-flex h-10 items-center justify-center rounded-xl border border-red-500/20 bg-red-500/10 text-red-300 hover:bg-red-500/20"
                      aria-label="Remover peça"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
              <div className="mt-3 text-right text-xs font-bold text-muted-foreground">
                Total peças:{" "}
                <span className="text-foreground">{fmtMoney(partsTotal)}</span>
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-sm font-bold text-foreground">
                  <ClipboardList size={15} className="text-blue-300" />
                  Mão de obra / Serviços
                </div>
                <button
                  type="button"
                  onClick={() => addBudgetItem("labor")}
                  className="inline-flex items-center gap-1 rounded-xl border border-blue-500/20 bg-blue-500/10 px-3 py-2 text-xs font-bold text-blue-200 hover:bg-blue-500/20"
                >
                  <Plus size={13} />
                  Adicionar serviço
                </button>
              </div>
              <div className="space-y-2">
                {form.labor.map((item, index) => (
                  <div
                    key={`labor-${index}`}
                    className="grid gap-2 rounded-xl border border-white/10 bg-black/20 p-3 md:grid-cols-[1fr_160px_38px]"
                  >
                    <Input
                      label="Serviço / mão de obra"
                      placeholder="Ex: Troca das pastilhas"
                      value={item.description}
                      onChange={(e) =>
                        updateBudgetItem(
                          "labor",
                          index,
                          "description",
                          e.target.value,
                        )
                      }
                    />
                    <Input
                      label="Valor R$"
                      placeholder="Ex: 120,00"
                      value={item.value}
                      onChange={(e) =>
                        updateBudgetItem(
                          "labor",
                          index,
                          "value",
                          e.target.value,
                        )
                      }
                    />
                    <button
                      type="button"
                      onClick={() => removeBudgetItem("labor", index)}
                      className="mt-6 inline-flex h-10 items-center justify-center rounded-xl border border-red-500/20 bg-red-500/10 text-red-300 hover:bg-red-500/20"
                      aria-label="Remover serviço"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
              <div className="mt-3 text-right text-xs font-bold text-muted-foreground">
                Total mão de obra:{" "}
                <span className="text-foreground">{fmtMoney(laborTotal)}</span>
              </div>
            </div>

            <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-right">
              <div className="text-xs font-bold uppercase tracking-wider text-red-200">
                Valor total do orçamento
              </div>
              <div className="mt-1 text-2xl font-black text-foreground">
                {fmtMoney(budgetTotal)}
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
              <div className="mb-3 flex items-center gap-2 text-sm font-bold text-foreground">
                <DollarSign size={15} className="text-green-400" />
                Condições de pagamento
              </div>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
                {[
                  "PIX",
                  "Dinheiro",
                  "Cartão",
                  "Entrada + entrega",
                  "Personalizado",
                ].map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() =>
                      setForm((p) => ({ ...p, payment_method: option }))
                    }
                    className={`rounded-xl border px-3 py-3 text-xs font-bold transition ${form.payment_method === option ? "border-red-500/40 bg-red-500/15 text-red-200" : "border-white/10 bg-black/20 text-muted-foreground hover:border-red-500/25 hover:text-foreground"}`}
                  >
                    {option}
                  </button>
                ))}
              </div>
              {(form.payment_method === "Cartão" ||
                form.payment_method === "Entrada + entrega" ||
                form.payment_method === "Personalizado") && (
                <div className="mt-3">
                  <Input
                    label="Detalhe da condição"
                    placeholder={
                      form.payment_method === "Cartão"
                        ? "Ex: em até 3x sem juros"
                        : form.payment_method === "Entrada + entrega"
                          ? "Ex: 50% de entrada e 50% na entrega"
                          : "Ex: boleto, transferência, combinado com cliente..."
                    }
                    value={form.payment_details}
                    onChange={set("payment_details")}
                  />
                </div>
              )}
            </div>

            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
              <div className="mb-3 flex items-center gap-2 text-sm font-bold text-foreground">
                <Calendar size={15} className="text-red-300" />
                Validade do orçamento
              </div>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                {["7 dias", "15 dias", "30 dias", "Data personalizada"].map(
                  (option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() =>
                        setForm((p) => ({ ...p, validity: option }))
                      }
                      className={`rounded-xl border px-3 py-3 text-xs font-bold transition ${form.validity === option ? "border-red-500/40 bg-red-500/15 text-red-200" : "border-white/10 bg-black/20 text-muted-foreground hover:border-red-500/25 hover:text-foreground"}`}
                    >
                      {option}
                    </button>
                  ),
                )}
              </div>
              {form.validity === "Data personalizada" && (
                <div className="mt-3">
                  <Input
                    label="Data ou prazo personalizado"
                    placeholder="Ex: válido até 20/07/2026"
                    value={form.custom_validity}
                    onChange={set("custom_validity")}
                  />
                </div>
              )}
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                <div className="mb-3 flex items-center gap-2 text-sm font-bold text-foreground">
                  <MessageCircle size={15} className="text-blue-300" />
                  Observação para o cliente
                </div>
                <Textarea
                  label=""
                  placeholder="Aparece no orçamento/PDF. Ex: Peças sujeitas à disponibilidade."
                  value={form.client_note}
                  onChange={set("client_note")}
                  rows={4}
                />
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                <div className="mb-3 flex items-center gap-2 text-sm font-bold text-foreground">
                  <Shield size={15} className="text-amber-300" />
                  Detalhes internos
                </div>
                <Textarea
                  label=""
                  placeholder="Só a oficina vê. Ex: cliente pediu desconto, aguardar fornecedor..."
                  value={form.internal_note}
                  onChange={set("internal_note")}
                  rows={4}
                />
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
              <p className="text-xs text-muted-foreground">
                Esse orçamento fica separado das Ordens de Serviço. Quando o
                cliente aprovar, clique em “Converter em O.S.”.
              </p>
            </div>
            <div className="flex gap-2 pt-1">
              <Btn
                type="button"
                variant="secondary"
                className="flex-1 justify-center"
                onClick={() => setModal(false)}
              >
                Cancelar
              </Btn>
              <Btn
                type="submit"
                variant="primary"
                className="flex-1 justify-center"
                loading={loading}
                disabled={loading}
              >
                {!loading && "Salvar Orçamento"}
              </Btn>
            </div>
          </form>
        </Modal>
      )}

      {confirmDel && (
        <Modal title="Excluir orçamento?" onClose={() => setConfirmDel(null)}>
          <p className="mb-4 text-sm text-muted-foreground">
            Esta ação não pode ser desfeita. O orçamento será removido do
            sistema.
          </p>
          <div className="flex gap-2">
            <Btn
              variant="secondary"
              className="flex-1 justify-center"
              onClick={() => setConfirmDel(null)}
            >
              Cancelar
            </Btn>
            <Btn
              variant="danger"
              className="flex-1 justify-center"
              onClick={() => del(confirmDel)}
            >
              <Trash2 size={13} />
              Excluir
            </Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

function OrdersPage({
  orders,
  clients,
  vehicles,
  onReload,
  onView,
}: {
  orders: ServiceOrder[];
  clients: Client[];
  vehicles: Vehicle[];
  onReload: () => Promise<void>;
  onView: (o: ServiceOrder) => void;
}) {
  const [filter, setFilter] = useState<"all" | OrderStatus>("all");
  const [search, setSearch] = useState("");
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState({
    client_id: "",
    vehicle_id: "",
    reported_issue: "",
    employee_name: "",
    services_performed: "",
    value: "",
    status: "aguardando" as OrderStatus,
    notes: "",
  });

  const [loading, setLoading] = useState(false);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [toast, setToast] = useState<{
    msg: string;
    type: "error" | "success";
  } | null>(null);

  function parseMoney(value?: string | number | null) {
    return Number(
      String(value || "0")
        .replace(/\./g, "")
        .replace(",", "."),
    );
  }

  function formatDate(date?: string | null) {
    if (!date) return "—";
    return new Date(date).toLocaleDateString("pt-BR");
  }

  function getClient(order: ServiceOrder) {
    return clients.find((c) => c.id === order.client_id);
  }

  function getVehicle(order: ServiceOrder) {
    return vehicles.find((v) => v.id === order.vehicle_id);
  }

  const clientVehicles = vehicles.filter((v) => v.client_id === form.client_id);

  const totalRevenue = orders.reduce(
    (acc, order) => acc + parseMoney(order.value),
    0,
  );

  const finishedOrders = orders.filter(
    (order) => order.status === "finalizado",
  );
  const activeOrders = orders.filter((order) => order.status !== "finalizado");
  const waitingOrders = orders.filter((order) => order.status === "aguardando");
  const maintenanceOrders = orders.filter(
    (order) => order.status === "em_manutencao",
  );

  const filteredByStatus =
    filter === "all"
      ? orders
      : orders.filter((order) => order.status === filter);

  const filtered = filteredByStatus.filter((order) => {
    const term = search.trim().toLowerCase();

    if (!term) return true;

    const client = getClient(order);
    const vehicle = getVehicle(order);

    return (
      String(client?.name || "")
        .toLowerCase()
        .includes(term) ||
      String(vehicle?.plate || "")
        .toLowerCase()
        .includes(term) ||
      String(vehicle?.brand || "")
        .toLowerCase()
        .includes(term) ||
      String(vehicle?.model || "")
        .toLowerCase()
        .includes(term) ||
      String(order.reported_issue || "")
        .toLowerCase()
        .includes(term) ||
      String(order.services_performed || "")
        .toLowerCase()
        .includes(term) ||
      String((order as any).employee_name || "")
        .toLowerCase()
        .includes(term)
    );
  });

  const sorted = [...filtered].sort((a, b) =>
    String(b.updated_at || b.created_at).localeCompare(
      String(a.updated_at || a.created_at),
    ),
  );

  function showToast(msg: string, type: "error" | "success") {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  }

  function openAdd() {
    const firstClient = clients[0];
    const firstVehicle = firstClient
      ? vehicles.find((v) => v.client_id === firstClient.id)
      : null;

    setForm({
      client_id: firstClient?.id ?? "",
      vehicle_id: firstVehicle?.id ?? "",
      reported_issue: "",
      employee_name: "",
      services_performed: "",
      value: "",
      status: "aguardando",
      notes: "",
    });

    setModal(true);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();

    if (!form.client_id) {
      showToast("Selecione um cliente.", "error");
      return;
    }

    if (!form.vehicle_id) {
      showToast("Selecione um veículo.", "error");
      return;
    }

    setLoading(true);

    try {
      await API.createOrder({
        ...form,
        employee_name: form.employee_name,
        value: String(
          Number(
            String(form.value || "0")
              .replace(/\./g, "")
              .replace(",", "."),
          ),
        ),
      } as any);

      await onReload();
      setModal(false);
      showToast("Ordem de serviço criada!", "success");
    } catch (err: any) {
      showToast(err.message || "Erro ao criar ordem de serviço.", "error");
    } finally {
      setLoading(false);
    }
  }

  async function del(id: string) {
    try {
      await API.deleteOrder(id);
      await onReload();
      setConfirmDel(null);
      showToast("Ordem excluída.", "success");
    } catch (err: any) {
      showToast(err.message || "Erro ao excluir ordem.", "error");
    }
  }

  const set =
    (k: keyof typeof form) =>
    (
      e: React.ChangeEvent<
        HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      >,
    ) => {
      const val = e.target.value;

      setForm((p) => {
        const next = { ...p, [k]: val };

        if (k === "client_id") {
          const veh = vehicles.find((v) => v.client_id === val);
          next.vehicle_id = veh?.id ?? "";
        }

        return next;
      });
    };

  const filters: Array<{
    key: "all" | OrderStatus;
    label: string;
    count: number;
  }> = [
    { key: "all", label: "Todas", count: orders.length },
    { key: "aguardando", label: "Aguardando", count: waitingOrders.length },
    {
      key: "em_manutencao",
      label: "Em manutenção",
      count: maintenanceOrders.length,
    },
    { key: "finalizado", label: "Finalizadas", count: finishedOrders.length },
  ];

  return (
    <div className="space-y-5">
      {toast && <Toast message={toast.msg} type={toast.type} />}

      <div className="overflow-hidden rounded-3xl border border-red-500/20 bg-gradient-to-br from-red-500/10 via-card to-black/40 p-5 shadow-[0_0_35px_rgba(239,68,68,0.08)]">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <div className="inline-flex rounded-full border border-red-500/20 bg-red-500/10 px-3 py-1 text-xs font-bold uppercase tracking-[0.18em] text-red-300">
              Central de Serviços
            </div>

            <h1 className="mt-4 font-heading text-3xl font-black tracking-tight text-foreground">
              Ordens de Serviço
            </h1>

            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Gerencie serviços em andamento, acompanhe status, valores e
              histórico de atendimento da oficina.
            </p>
          </div>

          <Btn
            variant="primary"
            onClick={openAdd}
            disabled={!clients.length || !vehicles.length}
            className="justify-center"
          >
            <Plus size={16} />
            Nova OS
          </Btn>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs text-muted-foreground">Total de OS</div>
              <div className="mt-2 text-2xl font-bold text-foreground">
                {orders.length}
              </div>
            </div>
            <ClipboardList size={20} className="text-primary" />
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs text-muted-foreground">OS Ativas</div>
              <div className="mt-2 text-2xl font-bold text-amber-400">
                {activeOrders.length}
              </div>
            </div>
            <Wrench size={20} className="text-amber-400" />
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs text-muted-foreground">Finalizadas</div>
              <div className="mt-2 text-2xl font-bold text-green-500">
                {finishedOrders.length}
              </div>
            </div>
            <CheckCircle size={20} className="text-green-500" />
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs text-muted-foreground">Valor total</div>
              <div className="mt-2 text-2xl font-bold text-green-500">
                {fmtMoney(totalRevenue)}
              </div>
            </div>
            <DollarSign size={20} className="text-green-500" />
          </div>
        </Card>
      </div>

      {(!clients.length || !vehicles.length) && (
        <div className="flex items-start gap-3 rounded-2xl border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-sm text-amber-200">
          <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
          <div>
            <p className="font-bold">Cadastro incompleto</p>
            <p className="text-xs text-amber-100/80">
              Cadastre pelo menos um cliente e um veículo antes de abrir uma
              ordem de serviço.
            </p>
          </div>
        </div>
      )}

      <Card className="p-4">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="relative w-full xl:max-w-md">
            <Search
              size={15}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />

            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar cliente, placa, veículo, problema..."
              className="w-full rounded-xl border border-border bg-input-background py-3 pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          <div className="flex flex-wrap gap-2">
            {filters.map((item) => {
              const active = filter === item.key;

              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setFilter(item.key)}
                  className={`rounded-xl border px-3 py-2 text-xs font-bold transition-all ${
                    active
                      ? item.key === "all"
                        ? "border-red-500/30 bg-red-500/15 text-red-300"
                        : STATUS_COLOR[item.key as OrderStatus]
                      : "border-white/10 bg-white/[0.03] text-muted-foreground hover:border-red-500/20 hover:text-foreground"
                  }`}
                >
                  {item.label} ({item.count})
                </button>
              );
            })}
          </div>
        </div>
      </Card>

      {sorted.length === 0 ? (
        <Card className="py-16 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-red-500/20 bg-red-500/10">
            <ClipboardList size={26} className="text-red-300" />
          </div>

          <h2 className="font-heading text-xl font-bold text-foreground">
            Nenhuma ordem encontrada
          </h2>

          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            {search
              ? "Tente buscar por outro cliente, placa ou serviço."
              : "Crie a primeira Ordem de Serviço para começar a organizar os atendimentos."}
          </p>

          {!search && (
            <Btn
              type="button"
              variant="primary"
              className="mx-auto mt-5"
              onClick={openAdd}
              disabled={!clients.length || !vehicles.length}
            >
              <Plus size={15} />
              Criar primeira OS
            </Btn>
          )}
        </Card>
      ) : (
        <div className="space-y-3">
          {sorted.map((order) => {
            const client = getClient(order);
            const vehicle = getVehicle(order);
            const employeeName = (order as any).employee_name;
            const deliveryDate = (order as any).delivery_date;

            return (
              <Card
                key={order.id}
                className="group overflow-hidden border-white/10 bg-[#0A0E13]/90 hover:border-red-500/25"
              >
                <div className="flex flex-col gap-4 p-4 xl:flex-row xl:items-center xl:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-red-500/20 bg-red-500/10 text-red-300">
                        <Car size={18} />
                      </div>

                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h2 className="font-heading text-base font-bold text-foreground">
                            {client?.name || "Cliente não informado"}
                          </h2>

                          <StatusBadge status={order.status} />
                        </div>

                        <p className="mt-1 text-xs text-muted-foreground">
                          {vehicle
                            ? `${vehicle.brand} ${vehicle.model} • ${vehicle.plate}`
                            : "Veículo não informado"}
                        </p>
                      </div>
                    </div>

                    <div className="mt-4 grid gap-3 md:grid-cols-3">
                      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
                        <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                          Problema
                        </p>

                        <p className="mt-1 truncate text-sm text-foreground">
                          {order.reported_issue || "Não informado"}
                        </p>
                      </div>

                      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
                        <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                          Responsável
                        </p>

                        <p className="mt-1 truncate text-sm text-foreground">
                          {employeeName || "Não definido"}
                        </p>
                      </div>

                      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
                        <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                          Previsão
                        </p>

                        <p className="mt-1 truncate text-sm text-foreground">
                          {deliveryDate ? formatDate(deliveryDate) : "Sem data"}
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-col gap-3 xl:w-64 xl:items-end">
                    <div className="w-full rounded-2xl border border-green-500/20 bg-green-500/10 px-4 py-3 xl:text-right">
                      <p className="text-xs text-muted-foreground">Valor</p>

                      <p className="mt-1 text-2xl font-black text-green-400">
                        {fmtMoney(order.value)}
                      </p>

                      <p className="mt-1 text-xs text-muted-foreground">
                        Criada em {formatDate(order.created_at)}
                      </p>
                    </div>

                    <div className="flex w-full flex-wrap gap-2 xl:justify-end">
                      <button
                        type="button"
                        onClick={() => onView(order)}
                        className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-bold text-white transition hover:border-red-500/25 hover:bg-red-500/10 xl:flex-none"
                      >
                        <Eye size={13} />
                        Visualizar
                      </button>

                      <button
                        type="button"
                        onClick={() => setConfirmDel(order.id)}
                        className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs font-bold text-red-300 transition hover:bg-red-500/20 xl:flex-none"
                      >
                        <Trash2 size={13} />
                        Excluir
                      </button>
                    </div>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {modal && (
        <Modal title="Nova Ordem de Serviço" onClose={() => setModal(false)}>
          <form onSubmit={save} className="flex flex-col gap-4">
            <Select
              label="Cliente"
              value={form.client_id}
              onChange={set("client_id")}
              required
            >
              <option value="">Selecione um cliente</option>

              {clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </Select>

            <Select
              label="Veículo"
              value={form.vehicle_id}
              onChange={set("vehicle_id")}
              required
            >
              <option value="">Selecione um veículo</option>

              {clientVehicles.map((vehicle) => (
                <option key={vehicle.id} value={vehicle.id}>
                  {vehicle.brand} {vehicle.model} • {vehicle.plate}
                </option>
              ))}
            </Select>

            <Textarea
              label="Problema relatado"
              placeholder="Ex: Barulho na suspensão dianteira..."
              value={form.reported_issue}
              onChange={set("reported_issue")}
              required
              rows={3}
            />

            <Textarea
              label="Serviços executados"
              placeholder="Ex: Diagnóstico, troca de peça, revisão..."
              value={form.services_performed}
              onChange={set("services_performed")}
              rows={3}
            />

            <Input
              label="Funcionário responsável"
              placeholder="Ex: João"
              value={form.employee_name}
              onChange={set("employee_name")}
            />

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <Input
                label="Valor"
                placeholder="Ex: 450,00"
                value={form.value}
                onChange={set("value")}
              />

              <Select
                label="Status"
                value={form.status}
                onChange={set("status")}
              >
                <option value="aguardando">Aguardando</option>
                <option value="em_manutencao">Em manutenção</option>
                <option value="finalizado">Finalizado</option>
              </Select>
            </div>

            <Textarea
              label="Observações"
              placeholder="Observações internas da oficina..."
              value={form.notes}
              onChange={set("notes")}
              rows={3}
            />

            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
              <p className="text-xs text-muted-foreground">
                Dica: quanto mais completa a OS, melhor fica o histórico do
                cliente, o PDF e o link público enviado pelo WhatsApp.
              </p>
            </div>

            <div className="flex gap-2 pt-1">
              <Btn
                type="button"
                variant="secondary"
                className="flex-1 justify-center"
                onClick={() => setModal(false)}
              >
                Cancelar
              </Btn>

              <Btn
                type="submit"
                variant="primary"
                className="flex-1 justify-center"
                loading={loading}
                disabled={loading}
              >
                {!loading && "Salvar OS"}
              </Btn>
            </div>
          </form>
        </Modal>
      )}

      {confirmDel && (
        <Modal
          title="Excluir ordem de serviço?"
          onClose={() => setConfirmDel(null)}
        >
          <p className="mb-4 text-sm text-muted-foreground">
            Esta ação não pode ser desfeita. A ordem será removida do sistema.
          </p>

          <div className="flex gap-2">
            <Btn
              variant="secondary"
              className="flex-1 justify-center"
              onClick={() => setConfirmDel(null)}
            >
              Cancelar
            </Btn>

            <Btn
              variant="danger"
              className="flex-1 justify-center"
              onClick={() => del(confirmDel)}
            >
              <Trash2 size={13} />
              Excluir
            </Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── Order Detail ─────────────────────────────────────────────────────────────

type OrderPhoto = {
  id: string;
  order_id: string;
  workshop_id: string;
  file_path: string;
  public_url: string;
  file_name: string;
  photo_type: "antes" | "depois" | "geral";
  created_at: string;
};

function OrderDetail({
  profile,
  order,
  clients,
  vehicles,
  onBack,
  onReload,
}: {
  profile: Profile | null;
  order: ServiceOrder;
  clients: Client[];
  vehicles: Vehicle[];
  onBack: () => void;
  onReload: () => Promise<void>;
}) {
  const client = clients.find((c) => c.id === order.client_id);
  const vehicle = vehicles.find((v) => v.id === order.vehicle_id);
  const workshopName = profile?.workshop_name || "Oficina";
  const workshopSignature =
    `${profile?.workshop_name || "Oficina"}\n` +
    `${profile?.whatsapp || profile?.phone ? `Tel/WhatsApp: ${profile?.whatsapp || profile?.phone}\n` : ""}` +
    `${profile?.city || profile?.state ? `${profile?.city || ""}${profile?.city && profile?.state ? " - " : ""}${profile?.state || ""}` : ""}`;

  const [editing, setEditing] = useState(false);
  const [current, setCurrent] = useState(order);
  const [form, setForm] = useState({
    client_id: order.client_id,
    vehicle_id: order.vehicle_id,
    reported_issue: order.reported_issue || "",
    services_performed: order.services_performed || "",
    employee_name: (order as any).employee_name || "",
    value: order.value || "0",
    status: order.status,
    notes: order.notes || "",
    delivery_date: (order as any).delivery_date || "",
    checklist: (order as any).checklist || "",
  });
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [photos, setPhotos] = useState<OrderPhoto[]>([]);
  const [toast, setToast] = useState<{
    msg: string;
    type: "error" | "success";
  } | null>(null);

  const set =
    (k: keyof typeof form) =>
    (
      e: React.ChangeEvent<
        HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      >,
    ) =>
      setForm((p) => ({ ...p, [k]: e.target.value }));

  function showToast(msg: string, type: "error" | "success") {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  }

  async function loadPhotos() {
    const { data, error } = await supabase
      .from("af_order_photos")
      .select("*")
      .eq("order_id", order.id)
      .order("created_at", { ascending: false });

    if (error) {
      console.warn("Fotos da OS indisponíveis:", error.message);
      return;
    }

    setPhotos((data ?? []) as OrderPhoto[]);
  }

  useEffect(() => {
    loadPhotos();
  }, [order.id]);

  function buildUpdateMessage(includePdfText = false) {
    const statusText =
      form.status === "aguardando"
        ? "Aguardando aprovação"
        : form.status === "em_manutencao"
          ? "Em manutenção"
          : "Finalizado";

    return (
      `Olá, ${client?.name || "cliente"}.\n\n` +
      `Sua Ordem de Serviço foi atualizada.\n\n` +
      `Veículo: ${vehicle?.brand || ""} ${vehicle?.model || ""} (${vehicle?.plate || "-"})\n` +
      `Status: ${statusText}\n` +
      `Valor: ${fmtMoney(form.value)}\n` +
      (getPublicOrderUrl(current)
        ? `Link de acompanhamento: ${getPublicOrderUrl(current)}\n`
        : "") +
      (form.delivery_date
        ? `Previsão de entrega: ${new Date(form.delivery_date).toLocaleDateString("pt-BR")}\n`
        : "") +
      `\nProblema relatado:\n${form.reported_issue || "-"}\n\n` +
      `Serviços realizados:\n${form.services_performed || "Em andamento"}\n\n` +
      (form.employee_name ? `Responsável: ${form.employee_name}\n\n` : "") +
      (includePdfText
        ? `O PDF anexado é a via digital da sua Ordem de Serviço. Ele contém os dados do veículo, problema relatado, serviços, status e valor registrado pela oficina.\n\n`
        : "") +
      `Em caso de dúvidas, estamos à disposição.\n\n` +
      `Obrigado pela preferência.\n\n` +
      `${workshopSignature}`
    );
  }

  function openWhatsApp(message: string) {
    const num = (client?.whatsapp || client?.phone || "").replace(/\D/g, "");

    if (!num) {
      showToast("Cliente sem WhatsApp cadastrado.", "error");
      return;
    }

    window.open(
      `https://wa.me/55${num}?text=${encodeURIComponent(message)}`,
      "_blank",
    );
  }

  function sendUpdateWhatsApp() {
    openWhatsApp(buildUpdateMessage(false));
  }

  async function sendPdfWhatsApp() {
    if (!client || !vehicle || !profile) {
      showToast("Não foi possível gerar o PDF. Dados incompletos.", "error");
      return;
    }

    await generateOrderPDF({
      order: {
        ...current,
        delivery_date: (current as any).delivery_date || undefined,
      },
      client,
      vehicle,
      workshop: {
        workshop_name: profile.workshop_name || undefined,
        owner_name: profile.owner_name || undefined,
        phone: profile.phone || undefined,
        whatsapp: profile.whatsapp || undefined,
        city: profile.city || undefined,
        state: profile.state || undefined,
        logo_url: profile.logo_url || undefined,
      },
    });

    openWhatsApp(buildUpdateMessage(true));
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);

    try {
      const previousStatus = current.status;

      const patch: Partial<ServiceOrder> & Record<string, any> = {
        reported_issue: form.reported_issue,
        services_performed: form.services_performed,
        employee_name: form.employee_name,
        value: String(
          Number(
            String(form.value || "0")
              .replace(/\./g, "")
              .replace(",", "."),
          ),
        ),
        status: form.status,
        notes: form.notes,
        delivery_date: form.delivery_date || null,
        checklist: form.checklist,
      };

      const updatedOrder = await API.updateOrder(order.id, patch);

      setCurrent(updatedOrder);
      setForm({
        client_id: updatedOrder.client_id,
        vehicle_id: updatedOrder.vehicle_id,
        reported_issue: updatedOrder.reported_issue || "",
        services_performed: updatedOrder.services_performed || "",
        employee_name: (updatedOrder as any).employee_name || "",
        value: updatedOrder.value || "0",
        status: updatedOrder.status,
        notes: updatedOrder.notes || "",
        delivery_date: (updatedOrder as any).delivery_date || "",
        checklist: (updatedOrder as any).checklist || "",
      });

      setEditing(false);
      await onReload();
      showToast("Ordem atualizada!", "success");

      if (
        previousStatus !== "finalizado" &&
        updatedOrder.status === "finalizado"
      ) {
        openWhatsApp(buildFinishedMessage(updatedOrder));
      }
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setLoading(false);
    }
  }

  async function quickStatus(status: OrderStatus) {
    try {
      const previousStatus = current.status;
      const updatedStatus = await API.updateOrder(order.id, { status });
      setCurrent(updatedStatus);
      setForm((p) => ({ ...p, status: updatedStatus.status }));
      await onReload();
      showToast(`Status: ${STATUS_LABEL[status]}`, "success");

      if (previousStatus !== "finalizado" && status === "finalizado") {
        openWhatsApp(buildFinishedMessage(updatedStatus));
      }
    } catch (err: any) {
      showToast(err.message, "error");
    }
  }

  function getPublicOrderUrl(orderData: ServiceOrder = current) {
    const token = (orderData as any).public_token;

    if (!token) return "";

    return `${window.location.origin}/os/${token}`;
  }

  function buildFinishedMessage(orderData: ServiceOrder) {
    const publicUrl = getPublicOrderUrl(orderData);

    return (
      `Olá, ${client?.name || "cliente"}.\n\n` +
      `Seu veículo ${vehicle?.brand || ""} ${vehicle?.model || ""} (${vehicle?.plate || "-"}) está pronto para retirada.\n\n` +
      `Valor do serviço: ${fmtMoney(orderData.value)}\n\n` +
      (publicUrl ? `Acompanhe sua OS pelo link:\n${publicUrl}\n\n` : "") +
      `Agradecemos pela confiança.\n\n` +
      `${workshopName}`
    );
  }

  async function uploadPhoto(file: File, photoType: OrderPhoto["photo_type"]) {
    const allowedPhotoTypes: Record<string, string> = {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/webp": "webp",
    };
    const safeExtension = allowedPhotoTypes[file.type];
    if (!safeExtension) {
      showToast("Use uma foto PNG, JPG ou WEBP.", "error");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      showToast("A foto deve ter no máximo 8 MB.", "error");
      return;
    }

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      showToast("Sessão expirada. Faça login novamente.", "error");
      return;
    }

    setUploading(true);

    try {
      const fileName = `${Date.now()}-${crypto.randomUUID()}.${safeExtension}`;
      const filePath = `${user.id}/${order.id}/${photoType}/${fileName}`;

      const { error: uploadError } = await supabase.storage
        .from("order-photos")
        .upload(filePath, file, { upsert: false, contentType: file.type });

      if (uploadError) throw uploadError;

      const { data: publicData } = supabase.storage
        .from("order-photos")
        .getPublicUrl(filePath);

      const { error: insertError } = await supabase
        .from("af_order_photos")
        .insert({
          workshop_id: user.id,
          order_id: order.id,
          file_path: filePath,
          public_url: publicData.publicUrl,
          file_name: file.name.slice(0, 200),
          photo_type: photoType,
        });

      if (insertError) throw insertError;

      await loadPhotos();
      showToast("Foto anexada à OS.", "success");
    } catch (err: any) {
      showToast(err.message || "Erro ao anexar foto.", "error");
    }

    setUploading(false);
  }

  async function deletePhoto(photo: OrderPhoto) {
    try {
      await supabase.storage.from("order-photos").remove([photo.file_path]);
      const { error } = await supabase
        .from("af_order_photos")
        .delete()
        .eq("id", photo.id);
      if (error) throw error;
      setPhotos((p) => p.filter((x) => x.id !== photo.id));
      showToast("Foto removida.", "success");
    } catch (err: any) {
      showToast(err.message || "Erro ao excluir foto.", "error");
    }
  }

  const publicUrl = getPublicOrderUrl(current);

  const detailItems = [
    { label: "Cliente", value: client?.name || "Cliente não informado" },
    {
      label: "Contato",
      value: client?.whatsapp || client?.phone || "Sem contato",
    },
    {
      label: "Veículo",
      value: vehicle
        ? `${vehicle.brand} ${vehicle.model}`
        : "Veículo não informado",
    },
    { label: "Placa", value: vehicle?.plate || "Sem placa" },
  ];

  return (
    <div className="space-y-5">
      {toast && <Toast message={toast.msg} type={toast.type} />}

      <div className="overflow-hidden rounded-3xl border border-red-500/20 bg-[radial-gradient(circle_at_top_right,rgba(239,68,68,0.22),transparent_34%),linear-gradient(135deg,rgba(239,68,68,0.10),rgba(11,15,20,0.95)_42%,rgba(0,0,0,0.92))] p-5 shadow-[0_0_45px_rgba(239,68,68,0.10)]">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <button
              type="button"
              onClick={onBack}
              className="mb-5 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-bold text-muted-foreground transition hover:border-red-500/30 hover:text-red-300"
            >
              <ArrowLeft size={13} />
              Voltar para ordens
            </button>

            <div className="inline-flex rounded-full border border-red-500/25 bg-red-500/10 px-3 py-1 text-xs font-black uppercase tracking-[0.2em] text-red-300">
              Ordem de Serviço
            </div>

            <h1 className="mt-4 font-heading text-3xl font-black tracking-tight text-white md:text-4xl">
              {vehicle ? `${vehicle.brand} ${vehicle.model}` : "Detalhe da OS"}
            </h1>

            <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span>{client?.name || "Cliente não informado"}</span>
              <span className="text-red-500/60">•</span>
              <span className="font-mono uppercase text-red-300">
                {vehicle?.plate || "Sem placa"}
              </span>
              <span className="text-red-500/60">•</span>
              <span>{fmt(current.created_at)}</span>
            </div>
          </div>

          <div className="flex flex-col gap-3 lg:items-end">
            <StatusBadge status={current.status} />

            <div className="text-left lg:text-right">
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
                Valor da OS
              </p>
              <p className="mt-1 text-3xl font-black text-green-500">
                {fmtMoney(current.value)}
              </p>
            </div>

            <div className="flex flex-wrap gap-2 lg:justify-end">
              <Btn
                type="button"
                variant="secondary"
                onClick={sendUpdateWhatsApp}
              >
                <MessageCircle size={14} />
                WhatsApp
              </Btn>

              <Btn type="button" variant="primary" onClick={sendPdfWhatsApp}>
                <FileText size={14} />
                Enviar PDF
              </Btn>

              <Btn
                type="button"
                variant={editing ? "ghost" : "secondary"}
                onClick={() => setEditing((v) => !v)}
              >
                <Edit2 size={14} />
                {editing ? "Cancelar" : "Editar"}
              </Btn>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {detailItems.map((item) => (
          <Card key={item.label} className="p-4">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-muted-foreground">
              {item.label}
            </p>
            <p className="mt-2 truncate text-sm font-bold text-foreground">
              {item.value}
            </p>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
        <Card className="p-5">
          <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="font-heading text-xl font-black text-foreground">
                {editing ? "Editar ordem" : "Resumo do serviço"}
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Problema, execução, checklist, observações e dados da entrega.
              </p>
            </div>

            {!editing && (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="inline-flex items-center gap-2 rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-2 text-sm font-bold text-red-300 transition hover:bg-red-500/20"
              >
                <Edit2 size={14} />
                Editar OS
              </button>
            )}
          </div>

          {editing ? (
            <form onSubmit={save} className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <Select
                  label="Status"
                  value={form.status}
                  onChange={set("status")}
                >
                  <option value="aguardando">Aguardando</option>
                  <option value="em_manutencao">Em manutenção</option>
                  <option value="finalizado">Finalizado</option>
                </Select>

                <Input
                  label="Valor"
                  value={form.value}
                  onChange={set("value")}
                />

                <Input
                  label="Funcionário responsável"
                  value={form.employee_name}
                  onChange={set("employee_name")}
                  placeholder="Ex: João"
                />

                <Input
                  label="Previsão de entrega"
                  type="date"
                  value={form.delivery_date}
                  onChange={set("delivery_date")}
                />
              </div>

              <Textarea
                label="Problema relatado"
                rows={4}
                value={form.reported_issue}
                onChange={set("reported_issue")}
              />

              <Textarea
                label="Serviços realizados"
                rows={4}
                value={form.services_performed}
                onChange={set("services_performed")}
              />

              <Textarea
                label="Checklist"
                rows={3}
                value={form.checklist}
                onChange={set("checklist")}
                placeholder="Itens verificados, peças, testes..."
              />

              <Textarea
                label="Observações"
                rows={3}
                value={form.notes}
                onChange={set("notes")}
              />

              <div className="flex flex-wrap justify-end gap-2 border-t border-white/10 pt-4">
                <Btn
                  type="button"
                  variant="secondary"
                  onClick={() => setEditing(false)}
                >
                  Cancelar
                </Btn>
                <Btn type="submit" variant="primary" loading={loading}>
                  {!loading && "Salvar alterações"}
                </Btn>
              </div>
            </form>
          ) : (
            <div className="space-y-4">
              <div className="grid gap-3 md:grid-cols-3">
                <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                  <p className="text-xs text-muted-foreground">Status</p>
                  <div className="mt-2">
                    <StatusBadge status={current.status} />
                  </div>
                </div>

                <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                  <p className="text-xs text-muted-foreground">Funcionário</p>
                  <p className="mt-2 text-sm font-bold text-foreground">
                    {form.employee_name || "—"}
                  </p>
                </div>

                <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                  <p className="text-xs text-muted-foreground">
                    Entrega prevista
                  </p>
                  <p className="mt-2 text-sm font-bold text-foreground">
                    {form.delivery_date
                      ? new Date(form.delivery_date).toLocaleDateString("pt-BR")
                      : "—"}
                  </p>
                </div>
              </div>

              <div className="rounded-2xl border border-red-500/15 bg-black/20 p-4">
                <p className="text-xs font-black uppercase tracking-[0.18em] text-red-300">
                  Problema relatado
                </p>
                <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                  {current.reported_issue || "—"}
                </p>
              </div>

              <div className="rounded-2xl border border-green-500/15 bg-green-500/[0.04] p-4">
                <p className="text-xs font-black uppercase tracking-[0.18em] text-green-300">
                  Serviços realizados
                </p>
                <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                  {current.services_performed || "Em andamento"}
                </p>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                  <p className="text-xs font-black uppercase tracking-[0.18em] text-muted-foreground">
                    Checklist
                  </p>
                  <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                    {form.checklist || "—"}
                  </p>
                </div>

                <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                  <p className="text-xs font-black uppercase tracking-[0.18em] text-muted-foreground">
                    Observações
                  </p>
                  <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                    {current.notes || "—"}
                  </p>
                </div>
              </div>
            </div>
          )}
        </Card>

        <div className="space-y-4">
          <Card className="p-5">
            <h2 className="font-heading text-lg font-black text-foreground">
              Ações rápidas
            </h2>
            <div className="mt-4 grid gap-2">
              <Btn
                type="button"
                variant="secondary"
                onClick={() => quickStatus("aguardando")}
              >
                <Clock size={14} /> Aguardando
              </Btn>
              <Btn
                type="button"
                variant="secondary"
                onClick={() => quickStatus("em_manutencao")}
              >
                <Wrench size={14} /> Em manutenção
              </Btn>
              <Btn
                type="button"
                variant="secondary"
                onClick={() => quickStatus("finalizado")}
              >
                <CheckCircle size={14} /> Finalizar OS
              </Btn>
            </div>
          </Card>

          <Card className="p-5">
            <h2 className="font-heading text-lg font-black text-foreground">
              Link público
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Envie para o cliente acompanhar a ordem sem login.
            </p>
            {publicUrl ? (
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(publicUrl);
                  showToast("Link copiado.", "success");
                }}
                className="mt-4 w-full rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm font-bold text-red-300 transition hover:bg-red-500/20"
              >
                Copiar link público
              </button>
            ) : (
              <p className="mt-4 rounded-xl border border-white/10 bg-white/[0.03] p-3 text-xs text-muted-foreground">
                Esta OS ainda não possui token público.
              </p>
            )}
          </Card>
        </div>
      </div>

      <Card className="p-5">
        <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="font-heading text-xl font-black text-foreground">
              Fotos da OS
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Antes, depois e registros gerais do serviço.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            {(["antes", "depois", "geral"] as OrderPhoto["photo_type"][]).map(
              (type) => (
                <label
                  key={type}
                  className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-2.5 text-sm font-bold text-red-300 transition hover:bg-red-500/20"
                >
                  <Upload size={14} />
                  {type === "antes"
                    ? "Antes"
                    : type === "depois"
                      ? "Depois"
                      : "Geral"}
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    disabled={uploading}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) uploadPhoto(file, type);
                      e.currentTarget.value = "";
                    }}
                  />
                </label>
              ),
            )}
          </div>
        </div>

        {photos.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.03] py-12 text-center">
            <ImageIcon
              size={30}
              className="mx-auto mb-2 text-muted-foreground/30"
            />
            <p className="text-sm text-muted-foreground">
              Nenhuma foto anexada.
            </p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {photos.map((photo) => (
              <div
                key={photo.id}
                className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03]"
              >
                <img
                  src={photo.public_url}
                  alt={photo.file_name}
                  className="h-44 w-full object-cover"
                />
                <div className="p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="rounded-full border border-red-500/20 bg-red-500/10 px-2 py-0.5 text-[10px] font-bold uppercase text-red-300">
                      {photo.photo_type}
                    </span>
                    <button
                      type="button"
                      onClick={() => deletePhoto(photo)}
                      className="text-muted-foreground transition hover:text-destructive"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {photo.file_name}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
function SettingsPage({ profile }: { profile: Profile | null }) {
  const [form, setForm] = useState({
    workshop_name: profile?.workshop_name ?? "",
    owner_name: profile?.owner_name ?? "",
    phone: profile?.phone ?? "",
    whatsapp: profile?.whatsapp ?? "",
    instagram: profile?.instagram ?? "",
    city: profile?.city ?? "",
    state: profile?.state ?? "",
    zip_code: profile?.zip_code ?? "",
    logo_url: profile?.logo_url ?? "",
  });

  const [toast, setToast] = useState<{
    msg: string;
    type: "success" | "error";
  } | null>(null);

  const setSettings =
    (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((p) => ({ ...p, [k]: e.target.value }));

  function onlyDigits(value?: string | null) {
    return String(value || "").replace(/\D/g, "");
  }

  function getCompletionRate() {
    const fields = [
      form.workshop_name,
      form.owner_name,
      form.phone,
      form.whatsapp,
      form.city,
      form.state,
      form.zip_code,
      form.logo_url,
    ];

    const filled = fields.filter((value) => String(value || "").trim()).length;

    return Math.round((filled / fields.length) * 100);
  }

  const completionRate = getCompletionRate();

  async function handleCepChange(e: React.ChangeEvent<HTMLInputElement>) {
    const cep = e.target.value.replace(/\D/g, "");

    setForm((p) => ({
      ...p,
      zip_code: e.target.value,
    }));

    if (cep.length !== 8) return;

    try {
      const res = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
      const data = await res.json();

      if (data.erro) return;

      setForm((p) => ({
        ...p,
        zip_code: e.target.value,
        city: data.localidade || "",
        state: data.uf || "",
      }));
    } catch {
      setToast({
        msg: "Não foi possível buscar o CEP automaticamente.",
        type: "error",
      });
    }
  }

  async function handleLogoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    const allowedLogoTypes: Record<string, string> = {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/webp": "webp",
    };
    const safeExtension = allowedLogoTypes[file.type];
    if (!safeExtension) {
      setToast({ msg: "Use uma imagem PNG, JPG ou WEBP.", type: "error" });
      e.target.value = "";
      return;
    }
    if (file.size > 3 * 1024 * 1024) {
      setToast({ msg: "A logo deve ter no máximo 3 MB.", type: "error" });
      e.target.value = "";
      return;
    }

    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        setToast({
          msg: "Usuário não encontrado.",
          type: "error",
        });
        return;
      }

      const fileName = `${user.id}/logo-${Date.now()}.${safeExtension}`;

      const { error } = await supabase.storage
        .from("workshop-logos")
        .upload(fileName, file, {
          upsert: true,
          contentType: file.type,
        });

      if (error) throw error;

      const { data } = supabase.storage
        .from("workshop-logos")
        .getPublicUrl(fileName);

      setForm((p) => ({
        ...p,
        logo_url: data.publicUrl,
      }));

      setToast({
        msg: "Logo enviada com sucesso! Agora clique em Salvar Alterações.",
        type: "success",
      });
    } catch {
      setToast({
        msg: "Erro ao enviar logo.",
        type: "error",
      });
    }
  }

  async function saveSettings() {
    try {
      const updatedProfile = await API.upsertProfile(form);

      setForm({
        workshop_name: updatedProfile.workshop_name ?? "",
        owner_name: updatedProfile.owner_name ?? "",
        phone: updatedProfile.phone ?? "",
        whatsapp: updatedProfile.whatsapp ?? "",
        instagram: updatedProfile.instagram ?? "",
        city: updatedProfile.city ?? "",
        state: updatedProfile.state ?? "",
        zip_code: updatedProfile.zip_code ?? "",
        logo_url: updatedProfile.logo_url ?? "",
      });

      setToast({
        msg: "Configurações salvas com sucesso!",
        type: "success",
      });

      setTimeout(() => {
        window.location.reload();
      }, 800);
    } catch (err: any) {
      setToast({
        msg: err.message || "Erro ao salvar configurações.",
        type: "error",
      });
    }
  }

  async function cancelSubscription() {
    const confirmCancel = window.confirm(
      "Tem certeza que deseja cancelar sua assinatura? Você continuará com acesso até o fim do período já pago.",
    );

    if (!confirmCancel) return;

    try {
      const data = await API.cancelSubscription();
      alert(data.message || "Assinatura cancelada com sucesso.");
    } catch (error: any) {
      const message = String(error?.message ?? "");
      if (message.toLowerCase().includes("não encontrada")) {
        alert("Você não possui uma assinatura mensal recorrente para cancelar.");
        return;
      }
      alert(message || "Erro ao cancelar assinatura.");
    }
  }

  return (
    <div className="space-y-5">
      {toast && <Toast message={toast.msg} type={toast.type} />}

      <div className="overflow-hidden rounded-3xl border border-red-500/20 bg-gradient-to-br from-red-500/10 via-card to-black/40 p-5 shadow-[0_0_35px_rgba(239,68,68,0.08)]">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="inline-flex rounded-full border border-red-500/20 bg-red-500/10 px-3 py-1 text-xs font-bold uppercase tracking-[0.18em] text-red-300">
              Central da Oficina
            </div>

            <h1 className="mt-4 font-heading text-3xl font-black tracking-tight text-foreground">
              Configurações
            </h1>

            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Mantenha os dados da oficina atualizados para melhorar PDFs,
              mensagens, identificação visual e atendimento ao cliente.
            </p>
          </div>

          <Btn type="button" variant="primary" onClick={saveSettings}>
            Salvar Alterações
          </Btn>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs text-muted-foreground">
                Perfil completo
              </div>
              <div className="mt-2 text-2xl font-bold text-red-400">
                {completionRate}%
              </div>
            </div>
            <CheckCircle size={20} className="text-red-400" />
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs text-muted-foreground">Logo</div>
              <div className="mt-2 text-2xl font-bold text-foreground">
                {form.logo_url ? "OK" : "—"}
              </div>
            </div>
            <ImageIcon size={20} className="text-primary" />
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs text-muted-foreground">WhatsApp</div>
              <div className="mt-2 text-2xl font-bold text-green-500">
                {onlyDigits(form.whatsapp) ? "OK" : "—"}
              </div>
            </div>
            <MessageCircle size={20} className="text-green-500" />
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs text-muted-foreground">Localização</div>
              <div className="mt-2 text-2xl font-bold text-blue-400">
                {form.city && form.state ? "OK" : "—"}
              </div>
            </div>
            <Building2 size={20} className="text-blue-400" />
          </div>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <Card className="p-5">
            <div className="mb-5 flex items-center justify-between gap-3">
              <div>
                <h2 className="font-heading text-lg font-bold text-foreground">
                  Identidade da oficina
                </h2>
                <p className="text-xs text-muted-foreground">
                  Nome, responsável e imagem que aparecem na Vortan.
                </p>
              </div>
              <Building2 size={20} className="text-primary" />
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Input
                label="Nome da Oficina"
                value={form.workshop_name}
                onChange={setSettings("workshop_name")}
              />

              <Input
                label="Responsável"
                value={form.owner_name}
                onChange={setSettings("owner_name")}
              />
            </div>

            <div className="mt-5 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
              <p className="text-xs text-muted-foreground">
                Esses dados ajudam a personalizar o painel, os PDFs e as
                mensagens enviadas aos clientes.
              </p>
            </div>
          </Card>

          <Card className="p-5">
            <div className="mb-5 flex items-center justify-between gap-3">
              <div>
                <h2 className="font-heading text-lg font-bold text-foreground">
                  Contato e redes
                </h2>
                <p className="text-xs text-muted-foreground">
                  Informações usadas em atendimento, WhatsApp e comunicação.
                </p>
              </div>
              <Phone size={20} className="text-primary" />
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Input
                label="Telefone"
                value={form.phone}
                onChange={setSettings("phone")}
              />

              <Input
                label="WhatsApp"
                value={form.whatsapp}
                onChange={setSettings("whatsapp")}
              />

              <Input
                label="Instagram"
                value={form.instagram}
                onChange={setSettings("instagram")}
              />
            </div>
          </Card>

          <Card className="p-5">
            <div className="mb-5 flex items-center justify-between gap-3">
              <div>
                <h2 className="font-heading text-lg font-bold text-foreground">
                  Endereço
                </h2>
                <p className="text-xs text-muted-foreground">
                  Use o CEP para preencher cidade e estado automaticamente.
                </p>
              </div>
              <Building2 size={20} className="text-primary" />
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <Input
                label="CEP"
                value={form.zip_code}
                onChange={handleCepChange}
              />

              <Input
                label="Cidade"
                value={form.city}
                onChange={setSettings("city")}
              />

              <Input
                label="Estado"
                value={form.state}
                onChange={setSettings("state")}
              />
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          <Card className="p-5">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="font-heading text-lg font-bold text-foreground">
                  Logo da oficina
                </h2>
                <p className="text-xs text-muted-foreground">
                  Aparece no sistema e nos PDFs.
                </p>
              </div>
              <ImageIcon size={20} className="text-primary" />
            </div>

            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
              {form.logo_url ? (
                <img
                  src={form.logo_url}
                  alt="Logo"
                  className="mx-auto mb-4 h-28 w-auto object-contain"
                />
              ) : (
                <div className="mb-4 flex h-28 items-center justify-center rounded-2xl border border-dashed border-white/10 bg-black/20 text-sm text-muted-foreground">
                  Sem logo enviada
                </div>
              )}

              <label className="inline-flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-bold text-white transition hover:bg-white/10">
                <Upload size={14} />
                Escolher logo
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleLogoUpload}
                />
              </label>

              <p className="mt-3 text-xs text-muted-foreground">
                PNG transparente recomendado. Tamanho sugerido: 1500x900 px.
              </p>
            </div>
          </Card>

          <Card className="p-5">
            <h2 className="font-heading text-lg font-bold text-foreground">
              Qualidade do perfil
            </h2>

            <div className="mt-4">
              <div className="mb-2 flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Preenchimento</span>
                <span className="font-bold text-foreground">
                  {completionRate}%
                </span>
              </div>

              <div className="h-3 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-red-500"
                  style={{ width: `${completionRate}%` }}
                />
              </div>
            </div>

            <p className="mt-4 rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-sm leading-relaxed text-red-100">
              Quanto mais completo o perfil, mais profissional ficam os PDFs,
              mensagens e links públicos enviados aos clientes.
            </p>
          </Card>

          <Card className="p-5">
            <h2 className="font-heading text-lg font-bold text-foreground">
              Assinatura
            </h2>

            <p className="mt-2 text-sm text-muted-foreground">
              Gerencie sua assinatura mensal recorrente da Vortan Oficina.
            </p>

            <Btn
              variant="secondary"
              className="mt-4 w-full justify-center border border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/20"
              onClick={cancelSubscription}
            >
              Cancelar assinatura mensal
            </Btn>
          </Card>
        </div>
      </div>

      <div className="rounded-3xl border border-red-500/20 bg-red-500/10 p-5">
        <p className="text-sm leading-relaxed text-red-100">
          Dica da Vortan: mantenha logo, WhatsApp e nome da oficina sempre
          atualizados. Isso aumenta a confiança do cliente quando ele recebe um
          PDF ou link público da ordem de serviço.
        </p>
      </div>
    </div>
  );
}

// ─── History ──────────────────────────────────────────────────────────────────

function HistoryPage({
  orders,
  clients,
  vehicles,
  onView,
}: {
  orders: ServiceOrder[];
  clients: Client[];
  vehicles: Vehicle[];
  onView: (o: ServiceOrder) => void;
}) {
  const [search, setSearch] = useState("");

  function parseMoney(value?: string | number | null) {
    return Number(
      String(value || "0")
        .replace(/\./g, "")
        .replace(",", "."),
    );
  }

  function formatDate(date?: string | null) {
    if (!date) return "—";
    return new Date(date).toLocaleDateString("pt-BR");
  }

  function getClient(order: ServiceOrder) {
    return clients.find((c) => c.id === order.client_id);
  }

  function getVehicle(order: ServiceOrder) {
    return vehicles.find((v) => v.id === order.vehicle_id);
  }

  const done = orders.filter(
    (o) => String(o.status).trim().toLowerCase() === "finalizado",
  );

  const totalRevenue = done.reduce(
    (acc, order) => acc + parseMoney(order.value),
    0,
  );
  const averageTicket = done.length > 0 ? totalRevenue / done.length : 0;

  const currentMonth = new Date().getMonth();
  const currentYear = new Date().getFullYear();

  const doneThisMonth = done.filter((order) => {
    const d = new Date(order.updated_at || order.created_at);
    return d.getMonth() === currentMonth && d.getFullYear() === currentYear;
  });

  const revenueThisMonth = doneThisMonth.reduce(
    (acc, order) => acc + parseMoney(order.value),
    0,
  );

  const uniqueClients = new Set(done.map((order) => order.client_id)).size;

  const filtered = done.filter((order) => {
    const client = getClient(order);
    const vehicle = getVehicle(order);
    const q = search.trim().toLowerCase();

    return (
      !q ||
      String(client?.name || "")
        .toLowerCase()
        .includes(q) ||
      String(vehicle?.plate || "")
        .toLowerCase()
        .includes(q) ||
      String(vehicle?.brand || "")
        .toLowerCase()
        .includes(q) ||
      String(vehicle?.model || "")
        .toLowerCase()
        .includes(q) ||
      String(order.reported_issue || "")
        .toLowerCase()
        .includes(q) ||
      String(order.services_performed || "")
        .toLowerCase()
        .includes(q) ||
      String((order as any).employee_name || "")
        .toLowerCase()
        .includes(q)
    );
  });

  const sorted = [...filtered].sort(
    (a, b) =>
      new Date(b.updated_at || b.created_at).getTime() -
      new Date(a.updated_at || a.created_at).getTime(),
  );

  const topClients = Object.entries(
    done.reduce<Record<string, { count: number; total: number }>>(
      (acc, order) => {
        const clientId = order.client_id || "sem-cliente";
        const current = acc[clientId] || { count: 0, total: 0 };

        acc[clientId] = {
          count: current.count + 1,
          total: current.total + parseMoney(order.value),
        };

        return acc;
      },
      {},
    ),
  )
    .map(([clientId, data]) => ({
      client: clients.find((c) => c.id === clientId),
      ...data,
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 4);

  const recentVehicles = Object.entries(
    done.reduce<Record<string, number>>((acc, order) => {
      const vehicleId = order.vehicle_id || "sem-veiculo";
      acc[vehicleId] = (acc[vehicleId] || 0) + 1;
      return acc;
    }, {}),
  )
    .map(([vehicleId, count]) => ({
      vehicle: vehicles.find((v) => v.id === vehicleId),
      count,
    }))
    .filter((item) => item.vehicle)
    .sort((a, b) => b.count - a.count)
    .slice(0, 4);

  return (
    <div className="space-y-5">
      <div className="overflow-hidden rounded-3xl border border-red-500/20 bg-gradient-to-br from-red-500/10 via-card to-black/40 p-5 shadow-[0_0_35px_rgba(239,68,68,0.08)]">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="inline-flex rounded-full border border-red-500/20 bg-red-500/10 px-3 py-1 text-xs font-bold uppercase tracking-[0.18em] text-red-300">
              Memória da Oficina
            </div>

            <h1 className="mt-4 font-heading text-3xl font-black tracking-tight text-foreground">
              Histórico
            </h1>

            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Consulte ordens finalizadas, serviços executados, clientes
              atendidos e faturamento registrado.
            </p>
          </div>

          <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
            <p className="text-xs text-muted-foreground">OS finalizadas</p>
            <p className="mt-1 text-2xl font-black text-white">{done.length}</p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs text-muted-foreground">
                Faturamento histórico
              </div>
              <div className="mt-2 text-2xl font-bold text-green-500">
                {fmtMoney(totalRevenue)}
              </div>
            </div>
            <DollarSign size={20} className="text-green-500" />
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs text-muted-foreground">
                Faturamento do mês
              </div>
              <div className="mt-2 text-2xl font-bold text-blue-400">
                {fmtMoney(revenueThisMonth)}
              </div>
            </div>
            <TrendingUp size={20} className="text-blue-400" />
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs text-muted-foreground">Ticket médio</div>
              <div className="mt-2 text-2xl font-bold text-red-400">
                {fmtMoney(averageTicket)}
              </div>
            </div>
            <Target size={20} className="text-red-400" />
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs text-muted-foreground">
                Clientes atendidos
              </div>
              <div className="mt-2 text-2xl font-bold text-foreground">
                {uniqueClients}
              </div>
            </div>
            <Users size={20} className="text-primary" />
          </div>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="p-5 xl:col-span-2">
          <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="font-heading text-lg font-bold text-foreground">
                Ordens finalizadas
              </h2>
              <p className="text-xs text-muted-foreground">
                {sorted.length} resultado(s) encontrado(s).
              </p>
            </div>

            <div className="relative w-full md:max-w-sm">
              <Search
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              />

              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar cliente, placa, serviço..."
                className="w-full rounded-xl border border-border bg-input-background py-2.5 pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          </div>

          {sorted.length === 0 ? (
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] py-14 text-center">
              <History
                size={30}
                className="mx-auto mb-2 text-muted-foreground/20"
              />

              <p className="text-sm text-muted-foreground">
                {search
                  ? "Nenhum resultado."
                  : "Nenhuma ordem finalizada ainda."}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {sorted.map((order) => {
                const client = getClient(order);
                const vehicle = getVehicle(order);
                const employeeName = (order as any).employee_name;

                return (
                  <button
                    key={order.id}
                    onClick={() => onView(order)}
                    className="group w-full rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-left transition hover:border-red-500/20 hover:bg-white/[0.05]"
                  >
                    <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-bold text-foreground">
                            {client?.name || "Cliente não informado"}
                          </span>

                          <span className="rounded-full border border-green-500/20 bg-green-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-green-300">
                            Finalizada
                          </span>

                          {vehicle && (
                            <span className="rounded-full border border-red-500/25 bg-red-500/10 px-3 py-1 font-mono text-xs font-bold uppercase tracking-wider text-red-300">
                              {vehicle.plate}
                            </span>
                          )}
                        </div>

                        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <Car size={11} />
                            {vehicle
                              ? `${vehicle.brand} ${vehicle.model}`
                              : "Veículo não informado"}
                          </span>

                          <span className="flex items-center gap-1">
                            <Calendar size={11} />
                            Finalizada em {formatDate(order.updated_at)}
                          </span>

                          {employeeName && (
                            <span className="flex items-center gap-1">
                              <Users size={11} />
                              {employeeName}
                            </span>
                          )}
                        </div>

                        {order.reported_issue && (
                          <p className="mt-3 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                            <span className="font-semibold text-foreground">
                              Problema:
                            </span>{" "}
                            {order.reported_issue}
                          </p>
                        )}

                        {order.services_performed && (
                          <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                            <span className="font-semibold text-foreground">
                              Serviço:
                            </span>{" "}
                            {order.services_performed}
                          </p>
                        )}
                      </div>

                      <div className="flex flex-col gap-3 xl:items-end">
                        <div className="xl:text-right">
                          <div className="text-lg font-bold text-green-500">
                            {fmtMoney(order.value)}
                          </div>

                          <div className="text-xs text-muted-foreground">
                            Criada em {formatDate(order.created_at)}
                          </div>
                        </div>

                        <div className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-bold text-white transition group-hover:bg-white/10">
                          <Eye size={13} />
                          Visualizar
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

// ─── Loading screen ───────────────────────────────────────────────────────────

function LoadingScreen() {
  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-4">
      <Logo />
      <RefreshCw
        size={20}
        className="text-muted-foreground animate-spin mt-2"
      />
    </div>
  );
}

// ─── App root ─────────────────────────────────────────────────────────────────

function isPaid(profile: Profile | null) {
  const p = profile as any;

  if (p?.is_admin === true) {
    return true;
  }

  const notExpired =
    p?.subscription_ends_at && new Date(p.subscription_ends_at) > new Date();

  const isActive = p?.subscription_status === "active" || p?.plan === "active";

  const isTrial = p?.subscription_status === "trial" || p?.plan === "trial";

  return Boolean((isActive || isTrial) && notExpired);
}

function PublicOrderPage({ token }: { token: string }) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(
          `https://kddlzartfawqjnrafzdb.supabase.co/functions/v1/rapid-action/public/orders/${token}`,
        );

        const json = await res.json();
        setData(json);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    }

    load();
  }, [token]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-foreground">
        Carregando...
      </div>
    );
  }

  if (!data?.order) {
    return (
      <div className="min-h-screen flex items-center justify-center text-destructive">
        Ordem de serviço não encontrada.
      </div>
    );
  }

  const { order, profile, client, vehicle } = data;

  return (
    <div className="min-h-screen bg-background p-4">
      <div className="max-w-3xl mx-auto space-y-4">
        <Card className="p-6 text-center">
          {profile?.logo_url && (
            <img
              src={profile.logo_url}
              alt="Logo"
              className="h-24 mx-auto mb-4 object-contain"
            />
          )}

          <h1 className="text-2xl font-bold text-foreground">
            {profile?.workshop_name}
          </h1>

          <p className="text-sm text-muted-foreground mt-1">
            Acompanhe o andamento do seu veículo em tempo real
          </p>
        </Card>

        <Card className="p-6">
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div>
              <p className="text-xs text-muted-foreground mb-1">STATUS</p>

              <StatusBadge status={order.status} />
            </div>

            <div className="text-right">
              <p className="text-xs text-muted-foreground">VALOR</p>

              <p className="text-2xl font-bold text-primary">
                {fmtMoney(order.value)}
              </p>
            </div>
          </div>
        </Card>

        {order.delivery_date && (
          <Card className="p-4">
            <p className="text-xs text-muted-foreground">PREVISÃO DE ENTREGA</p>

            <p className="font-semibold">{fmt(order.delivery_date)}</p>
          </Card>
        )}

        <Card className="p-6 space-y-4">
          <div>
            <p className="text-xs text-muted-foreground">CLIENTE</p>

            <p className="font-medium text-foreground">{client?.name ?? "-"}</p>
          </div>

          <div>
            <p className="text-xs text-muted-foreground">VEÍCULO</p>

            <p className="font-medium text-foreground">
              {vehicle?.brand} {vehicle?.model}
            </p>
          </div>

          <div>
            <p className="text-xs text-muted-foreground">PLACA</p>

            <p className="font-mono text-foreground">{vehicle?.plate}</p>
          </div>
        </Card>

        <Card className="p-6">
          <h2 className="font-semibold text-lg mb-2">Problema Relatado</h2>

          <p className="text-muted-foreground">{order.reported_issue || "-"}</p>
        </Card>

        <Card className="p-6">
          <h2 className="font-semibold text-lg mb-2">Serviços Executados</h2>

          <p className="text-muted-foreground whitespace-pre-wrap">
            {order.services_performed || "-"}
          </p>
        </Card>

        {order.notes && (
          <Card className="p-6">
            <h2 className="font-semibold text-lg mb-2">Observações</h2>

            <p className="text-muted-foreground whitespace-pre-wrap">
              {order.notes}
            </p>
          </Card>
        )}

        {profile?.whatsapp && (
          <Card className="p-4 text-center">
            <p className="text-sm text-muted-foreground">
              Dúvidas sobre o serviço?
            </p>

            <p className="font-semibold text-primary mt-1">
              WhatsApp: {profile.whatsapp}
            </p>
          </Card>
        )}

        <div className="text-center text-xs text-muted-foreground py-4">
          Um produto da Vortan Systems
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [profile, setProfile] = useState<Profile | null>(null);
  /*const [needsOnboarding, setNeedsOnboarding] = useState(false);*/
  const [authPage, setAuthPage] = useState<
    "landing" | "login" | "register" | "terms" | "privacy"
  >("landing");
  const [page, setPage] = useState<Page>("dashboard");
  const [activeOrder, setActiveOrder] = useState<ServiceOrder | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const [clients, setClients] = useState<Client[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [orders, setOrders] = useState<ServiceOrder[]>([]);
  const [financialEntries, setFinancialEntries] = useState<FinancialEntry[]>(
    [],
  );
  const [dataLoaded, setDataLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [checkingPayment, setCheckingPayment] = useState(false);
  const [paymentRedirecting, setPaymentRedirecting] = useState<
    "subscription" | "single" | null
  >(null);

  const navigate = useNavigate();
  const location = useLocation();

  const publicOrderToken = window.location.pathname.startsWith("/os/")
    ? window.location.pathname.replace("/os/", "").trim()
    : null;

  // Auth state
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setSessionLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      setSessionLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    const path = location.pathname;

    if (path.startsWith("/os/")) return;

    if (path === "/login") {
      setAuthPage("login");
      return;
    }

    if (path === "/cadastrar") {
      setAuthPage("register");
      return;
    }

    if (path === "/termos") {
      setAuthPage("terms");
      return;
    }

    if (path === "/privacidade") {
      setAuthPage("privacy");
      return;
    }

    if (path === "/dashboard") {
      setPage("dashboard");
      return;
    }

    if (path === "/") {
      setAuthPage("landing");
      return;
    }
  }, [location.pathname]);

  useEffect(() => {
    if (sessionLoading) return;

    if (!session && location.pathname === "/dashboard") {
      navigate("/login", { replace: true });
      return;
    }

    if (
      session &&
      (location.pathname === "/login" || location.pathname === "/cadastrar")
    ) {
      navigate("/dashboard", { replace: true });
    }
  }, [session, sessionLoading, location.pathname, navigate]);

  useEffect(() => {
    const path = location.pathname;

    if (path.startsWith("/os/")) return;

    if (path === "/login") {
      setAuthPage("login");
      return;
    }

    if (path === "/cadastrar") {
      setAuthPage("register");
      return;
    }

    if (path === "/dashboard") {
      setPage("dashboard");
      return;
    }

    if (path === "/") {
      setAuthPage("landing");
      return;
    }
  }, [location.pathname]);

  useEffect(() => {
    if (sessionLoading) return;

    if (!session && location.pathname === "/dashboard") {
      navigate("/login", { replace: true });
      return;
    }

    if (
      session &&
      (location.pathname === "/login" || location.pathname === "/cadastrar")
    ) {
      navigate("/dashboard", { replace: true });
    }
  }, [session, sessionLoading, location.pathname, navigate]);

  // Setup DB + load data when session available
  useEffect(() => {
    if (!session) {
      setDataLoaded(false);
      setLoadError(null);
      setProfile(null);
      setClients([]);
      setVehicles([]);
      setOrders([]);
      setFinancialEntries([]);

      /*setNeedsOnboarding(false);*/
      return;
    }

    let cancelled = false;

    async function getProfileWithRetry(): Promise<Profile | null> {
      let lastError: unknown = null;

      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          return await API.getProfile();
        } catch (error) {
          lastError = error;

          if (attempt < 2) {
            await new Promise((resolve) =>
              setTimeout(resolve, 350 * (attempt + 1)),
            );
          }
        }
      }

      throw lastError instanceof Error
        ? lastError
        : new Error("Não foi possível carregar o perfil.");
    }

    async function init() {
      setDataLoaded(false);
      setLoadError(null);

      let p: Profile | null;

      try {
        p = await getProfileWithRetry();
      } catch (error) {
        console.error("Falha ao carregar perfil:", error);

        if (!cancelled) {
          setProfile(null);
          setLoadError(
            "Não foi possível carregar sua conta agora. Tente novamente.",
          );
          setDataLoaded(true);
        }

        return;
      }

      const pendingProfileRaw = localStorage.getItem(
        "vortanoficina_pending_profile",
      );

      let pendingProfile: {
        owner_name?: string;
        workshop_name?: string;
      } | null = null;

      if (pendingProfileRaw) {
        try {
          pendingProfile = JSON.parse(pendingProfileRaw);
        } catch {
          localStorage.removeItem("vortanoficina_pending_profile");
        }
      }

      const metadata = session.user.user_metadata ?? {};
      const shouldInitializeTrial =
        !p || Boolean(pendingProfile) || p.subscription_status === "pending";

      if (shouldInitializeTrial) {
        try {
          p = await API.upsertProfile({
            workshop_name:
              pendingProfile?.workshop_name ||
              metadata.workshop_name ||
              p?.workshop_name ||
              "Minha Oficina",
            owner_name:
              pendingProfile?.owner_name ||
              metadata.owner_name ||
              metadata.name ||
              p?.owner_name ||
              "Usuário",
            phone: p?.phone ?? "",
            whatsapp: p?.whatsapp ?? "",
            instagram: p?.instagram ?? "",
            city: p?.city ?? "",
            state: p?.state ?? "",
            logo_url: p?.logo_url ?? "",
          });
          localStorage.removeItem("vortanoficina_pending_profile");
        } catch (profileError) {
          console.error(
            "Não foi possível concluir o perfil inicial:",
            profileError,
          );
        }
      }

      if (!p) {
        console.warn("Perfil não encontrado.");

        if (!cancelled) {
          setProfile(null);
          setLoadError(
            "Não foi possível carregar seu perfil. Tente novamente.",
          );
          setDataLoaded(true);
        }

        return;
      }

      if (cancelled) return;

      // O perfil é a fonte de verdade para acesso. Só depois dele carregar
      // buscamos os demais dados, evitando tratar falha de rede como assinatura.
      setProfile(p);

      const [cls, vehs, ords, fins] = await Promise.allSettled([
        API.getClients(),
        API.getVehicles(),
        API.getOrders(),
        API.getFinancialEntries(),
      ]);

      if (cancelled) return;

      setClients(cls.status === "fulfilled" ? cls.value : []);
      setVehicles(vehs.status === "fulfilled" ? vehs.value : []);
      setOrders(ords.status === "fulfilled" ? ords.value : []);
      setFinancialEntries(fins.status === "fulfilled" ? fins.value : []);
      setDataLoaded(true);
    }

    void init();

    return () => {
      cancelled = true;
    };
  }, [session]);

  const loadClients = useCallback(async () => {
    const data = await API.getClients();
    setClients(data);
  }, []);

  const loadVehicles = useCallback(async () => {
    const data = await API.getVehicles();
    setVehicles(data);
  }, []);

  const loadOrders = useCallback(async () => {
    const data = await API.getOrders();
    setOrders(data);
  }, []);

  const loadAll = useCallback(async () => {
    const [cls, vehs, ords, fins] = await Promise.all([
      API.getClients(),
      API.getVehicles(),
      API.getOrders(),
      API.getFinancialEntries(),
    ]);

    setClients(cls);
    setVehicles(vehs);
    setOrders(ords);
    setFinancialEntries(fins);
  }, []);

  const loadFinancialEntries = useCallback(async () => {
    const data = await API.getFinancialEntries();
    setFinancialEntries(data);
  }, []);

  function nav(p: Page) {
    setPage(p);
    setSidebarOpen(false);
    if (p !== "order-detail") setActiveOrder(null);
  }

  function viewOrder(o: ServiceOrder) {
    setActiveOrder(o);
    setPage("order-detail");
  }

  async function logout() {
    await supabase.auth.signOut();
    setAuthPage("login");
    setPage("dashboard");
    setSidebarOpen(false);
    navigate("/login", { replace: true });
  }

  // ── Reset password ────────────────────────────────────────────────────────────────

  function ResetPasswordScreen() {
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [error, setError] = useState("");
    const [success, setSuccess] = useState("");
    const [loading, setLoading] = useState(false);

    async function handleUpdatePassword(e: React.FormEvent) {
      e.preventDefault();
      setError("");
      setSuccess("");

      if (password.length < 8) {
        setError("A senha precisa ter pelo menos 8 caracteres.");
        return;
      }

      if (!/[A-Z]/.test(password)) {
        setError("A senha precisa ter pelo menos uma letra maiúscula.");
        return;
      }

      if (!/[a-z]/.test(password)) {
        setError("A senha precisa ter pelo menos uma letra minúscula.");
        return;
      }

      if (!/[0-9]/.test(password)) {
        setError("A senha precisa ter pelo menos um número.");
        return;
      }

      if (password !== confirmPassword) {
        setError("As senhas não conferem.");
        return;
      }

      setLoading(true);

      const { error } = await supabase.auth.updateUser({
        password,
      });

      if (error) {
        setError("Não foi possível alterar sua senha. Tente novamente.");
      } else {
        setSuccess(
          "Senha alterada com sucesso. Você já pode entrar novamente.",
        );
        setTimeout(() => {
          window.location.href = "/";
        }, 2000);
      }

      setLoading(false);
    }

    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center px-4">
        <div className="w-full max-w-sm">
          <div className="text-center mb-8">
            <Logo />
            <p className="text-sm text-muted-foreground mt-2">
              Crie uma nova senha para acessar sua conta
            </p>
          </div>

          <Card className="p-6">
            <h1 className="font-heading font-bold text-xl mb-5 text-foreground">
              Redefinir senha
            </h1>

            <form
              onSubmit={handleUpdatePassword}
              className="flex flex-col gap-4"
            >
              <Input
                label="Nova senha"
                type="password"
                placeholder="Digite sua nova senha"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="new-password"
              />

              <Input
                label="Confirmar senha"
                type="password"
                placeholder="Confirme sua nova senha"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                autoComplete="new-password"
              />

              <AuthError msg={error || success} />

              <Btn
                type="submit"
                variant="primary"
                className="w-full justify-center"
                loading={loading}
              >
                {!loading && "Salvar nova senha"}
              </Btn>
            </form>
          </Card>
        </div>
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const isResetPasswordPage =
    window.location.search.includes("reset-password=true") ||
    window.location.hash.includes("type=recovery") ||
    window.location.hash.includes("access_token");

  if (publicOrderToken) {
    return <PublicOrderPage token={publicOrderToken} />;
  }
  if (sessionLoading) return <LoadingScreen />;

  console.log("SEARCH:", window.location.search);
  console.log("RESET PAGE:", isResetPasswordPage);

  if (isResetPasswordPage) {
    console.log("ENTROU NO RESET");
    return <ResetPasswordScreen />;
  }

  if (!session) {
    if (authPage === "register") {
      return <RegisterScreen onGoLogin={() => navigate("/login")} />;
    }

    if (authPage === "login") {
      return <LoginScreen onGoRegister={() => navigate("/cadastrar")} />;
    }

    if (authPage === "terms") {
      return <TermsPage onBack={() => navigate("/")} />;
    }

    if (authPage === "privacy") {
      return <PrivacyPage onBack={() => navigate("/")} />;
    }

    return (
      <LandingPage
        onGoLogin={() => navigate("/login")}
        onGoRegister={() => navigate("/cadastrar")}
        onGoTerms={() => navigate("/termos")}
        onGoPrivacy={() => navigate("/privacidade")}
      />
    );
  }
  /*
  if (needsOnboarding) {
    return (
      <OnboardingScreen
        user={session.user}
        onDone={async (p) => {
          setProfile(p);
          setNeedsOnboarding(false);
          await loadAll();
          setDataLoaded(true);
        }}
      />
    );
  }
*/
  if (!dataLoaded) return <LoadingScreen />;

  if (loadError) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center px-4">
        <div className="w-full max-w-sm text-center">
          <Logo />
          <Card className="p-6 mt-6">
            <AlertCircle size={28} className="text-destructive mx-auto mb-3" />
            <h1 className="font-heading font-bold text-xl text-foreground mb-2">
              Não foi possível carregar sua conta
            </h1>
            <p className="text-sm text-muted-foreground mb-5">{loadError}</p>
            <Btn
              variant="primary"
              className="w-full justify-center"
              onClick={() => window.location.reload()}
            >
              Tentar novamente
            </Btn>
          </Card>
        </div>
      </div>
    );
  }

  if (!profile || !isPaid(profile)) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center px-4">
        <div className="w-full max-w-sm text-center">
          <Logo />

          <Card className="p-6 mt-6">
            <h1 className="font-heading font-bold text-2xl text-foreground mb-3">
              Assinatura necessária
            </h1>

            <p className="text-sm text-muted-foreground mb-5">
              Sua conta está criada. Para acessar o painel, finalize a
              assinatura.
            </p>

            <Btn
              variant="primary"
              className="w-full justify-center"
              loading={paymentRedirecting === "subscription"}
              onClick={async () => {
                setPaymentRedirecting("subscription");
                try {
                  const data = await API.createSubscriptionCheckout();
                  if (!data.checkout_url) {
                    throw new Error("O Asaas não retornou o link de pagamento.");
                  }
                  window.location.href = data.checkout_url;
                } catch (error: any) {
                  alert(error?.message || "Não foi possível abrir o pagamento recorrente.");
                  setPaymentRedirecting(null);
                }
              }}
            >
              {paymentRedirecting !== "subscription" ? "Assinar plano mensal" : null}
            </Btn>

            <Btn
              variant="primary"
              className="w-full justify-center mt-3"
              loading={paymentRedirecting === "single"}
              onClick={async () => {
                setPaymentRedirecting("single");
                try {
                  const data = await API.createCheckout();
                  if (!data.checkout_url) {
                    throw new Error("O Asaas não retornou o link de pagamento.");
                  }
                  window.location.href = data.checkout_url;
                } catch (error: any) {
                  alert(error?.message || "Não foi possível abrir o pagamento.");
                  setPaymentRedirecting(null);
                }
              }}
            >
              {paymentRedirecting !== "single" ? "Pagar apenas este mês" : null}
            </Btn>

            <Btn
              variant="secondary"
              className="w-full max-w-[230px] mx-auto justify-center mt-3 text-sm"
              loading={checkingPayment}
              onClick={async () => {
                setCheckingPayment(true);

                try {
                  const updated = await API.getProfile();
                  console.log("PROFILE ATUALIZADO:", updated);
                  setProfile(updated);

                  if (isPaid(updated)) {
                    setPage("dashboard");
                    await loadAll();
                  } else {
                    alert("Pagamento ainda não confirmado.");
                  }
                } finally {
                  setCheckingPayment(false);
                }
              }}
            >
              {!checkingPayment ? "Já paguei, atualizar acesso" : null}
            </Btn>

            <Btn
              variant="ghost"
              className="w-full justify-center mt-2"
              onClick={logout}
            >
              Sair
            </Btn>
          </Card>
        </div>

      </div>
    );
  }

  return (
    <div
      className="min-h-screen bg-[#05070A] dark relative overflow-hidden"
      style={{ fontFamily: "var(--font-body, 'DM Sans', sans-serif)" }}
    >
      {/* Background premium do sistema logado */}
      <div className="fixed left-[-280px] top-[8%] w-[720px] h-[720px] rounded-full bg-red-500/10 blur-[220px] pointer-events-none z-0" />
      <div className="fixed right-[-280px] bottom-[5%] w-[720px] h-[720px] rounded-full bg-red-500/15 blur-[220px] pointer-events-none z-0" />
      <div className="fixed inset-0 opacity-[0.025] pointer-events-none z-0 bg-[linear-gradient(rgba(239,68,68,1)_1px,transparent_1px),linear-gradient(90deg,rgba(239,68,68,1)_1px,transparent_1px)] bg-[size:80px_80px]" />

      <div className="relative z-20">
        <Sidebar
          profile={profile}
          page={page}
          onNav={nav}
          onLogout={logout}
          open={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
        />
      </div>

      <div className="relative z-10 lg:pl-64 min-h-screen flex flex-col">
        {/* Mobile header */}
        <header className="lg:hidden sticky top-0 z-20 bg-sidebar/90 backdrop-blur-md border-b border-sidebar-border px-4 py-3 flex items-center justify-between">
          <button
            onClick={() => setSidebarOpen(true)}
            className="text-muted-foreground hover:text-foreground p-0.5"
          >
            <Menu size={20} />
          </button>
          <Logo size="sm" />
          <div className="w-8" />
        </header>

        <main className="flex-1 px-4 py-5 max-w-6xl mx-auto w-full pb-8">
          {page === "dashboard" && (
            <Dashboard
              clients={clients}
              vehicles={vehicles}
              orders={orders.filter((o) => !isBudgetOrder(o))}
              profile={profile}
              onNav={nav}
              onViewOrder={viewOrder}
            />
          )}

          {page === "clients" && (
            <ClientsPage clients={clients} onReload={loadAll} />
          )}

          {page === "vehicles" && (
            <VehiclesPage
              vehicles={vehicles}
              clients={clients}
              onReload={loadAll}
            />
          )}

          {page === "budgets" && (
            <BudgetsPage
              profile={profile}
              orders={orders.filter(isBudgetOrder)}
              clients={clients}
              vehicles={vehicles}
              onReload={loadAll}
            />
          )}

          {page === "orders" && (
            <OrdersPage
              orders={orders.filter((o) => !isBudgetOrder(o))}
              clients={clients}
              vehicles={vehicles}
              onReload={loadAll}
              onView={viewOrder}
            />
          )}

          {page === "order-detail" && activeOrder && (
            <OrderDetail
              profile={profile}
              order={activeOrder}
              clients={clients}
              vehicles={vehicles}
              onBack={() => nav("orders")}
              onReload={loadAll}
            />
          )}

          {page === "history" && (
            <HistoryPage
              orders={orders.filter((o) => !isBudgetOrder(o))}
              clients={clients}
              vehicles={vehicles}
              onView={(order) => {
                setActiveOrder(order);
                nav("order-detail");
              }}
            />
          )}

          {page === "financial" && (
            <FinancialPage
              orders={orders.filter((o) => !isBudgetOrder(o))}
              entries={financialEntries}
              onReload={loadAll}
            />
          )}

          {page === "admin" && profile?.is_admin && <AdminPage />}

          {page === "settings" && <SettingsPage profile={profile} />}
        </main>
      </div>
    </div>
  );
}

function TermsPage({ onBack }: { onBack: () => void }) {
  const sections = [
    {
      title: "1. Aceite dos Termos",
      body: "Ao acessar ou utilizar a Vortan Oficina, o usuário declara estar de acordo com estes Termos de Uso. Caso não concorde com alguma condição, recomendamos que não utilize a plataforma.",
    },
    {
      title: "2. Sobre a Vortan Oficina",
      body: "A Vortan Oficina é uma plataforma de gestão para oficinas mecânicas, criada para auxiliar no controle de clientes, veículos, ordens de serviço, financeiro e comunicação com clientes.",
    },
    {
      title: "3. Responsabilidades do usuário",
      body: "O usuário é responsável pela veracidade das informações cadastradas no sistema, incluindo dados de clientes, veículos, serviços, valores, observações e movimentações financeiras.",
    },
    {
      title: "4. Assinatura e acesso",
      body: "O acesso ao sistema pode depender de assinatura ativa. Em caso de inadimplência, expiração do plano ou uso indevido, o acesso à plataforma poderá ser limitado ou suspenso.",
    },

    {
      title: "5. Cobrança recorrente e cancelamento",
      body: "Ao contratar um plano da Vortan Oficina, o usuário autoriza a cobrança recorrente da assinatura pelo método de pagamento escolhido. O cancelamento poderá ser solicitado a qualquer momento, permanecendo o acesso ativo até o término do período já pago.",
    },
    {
      title: "6. Inadimplência e suspensão",
      body: "Em caso de falha na cobrança, pagamento recusado, vencimento não quitado ou qualquer situação de inadimplência, a Vortan Oficina poderá limitar ou suspender o acesso à plataforma até a regularização dos valores pendentes. Após período prolongado de inadimplência, a assinatura poderá ser cancelada.",
    },

    {
      title: "7. Uso adequado da plataforma",
      body: "O usuário se compromete a utilizar a Vortan Oficina apenas para fins lícitos, profissionais e relacionados à gestão da oficina, não podendo tentar violar, copiar, explorar ou prejudicar o funcionamento do sistema.",
    },
    {
      title: "8. Alterações nos Termos",
      body: "Estes Termos podem ser atualizados a qualquer momento para refletir melhorias, mudanças legais ou ajustes operacionais. A versão mais recente estará sempre disponível nesta página.",
    },
  ];

  return (
    <div className="min-h-screen text-foreground bg-[#05070A] relative overflow-hidden">
      <div className="fixed left-[-220px] top-1/4 w-[520px] h-[520px] rounded-full bg-red-500/10 blur-[180px] pointer-events-none" />
      <div className="fixed right-[-220px] top-1/3 w-[520px] h-[520px] rounded-full bg-red-500/10 blur-[180px] pointer-events-none" />
      <div className="fixed inset-0 opacity-[0.025] pointer-events-none bg-[linear-gradient(rgba(239,68,68,1)_1px,transparent_1px),linear-gradient(90deg,rgba(239,68,68,1)_1px,transparent_1px)] bg-[size:80px_80px]" />

      <div className="relative max-w-6xl mx-auto px-4 py-8">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-primary transition-colors mb-8"
        >
          <ArrowLeft size={16} />
          Voltar para o início
        </button>

        <div className="grid lg:grid-cols-[1fr_360px] gap-6 items-start">
          <div className="space-y-6">
            <Card className="p-8 border-primary/20 overflow-hidden relative">
              <div className="absolute top-0 right-0 w-60 h-60 bg-red-500/10 blur-[90px] rounded-full pointer-events-none" />

              <div className="relative">
                <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-red-500/20 bg-red-500/10 text-red-400 text-xs font-medium mb-5">
                  <FileText size={14} />
                  Documento legal Vortan Oficina
                </div>

                <h1 className="text-4xl md:text-5xl font-bold tracking-tight">
                  Termos de Uso
                </h1>

                <p className="text-muted-foreground mt-4 text-base max-w-3xl leading-relaxed">
                  Leia com atenção as condições de uso da plataforma Vortan
                  Oficina. Este documento explica as principais regras para
                  utilização do sistema, assinatura, responsabilidades e
                  funcionamento geral.
                </p>

                <div className="mt-6 flex flex-wrap gap-3 text-xs text-muted-foreground">
                  <span className="px-3 py-1.5 rounded-full border border-border bg-secondary/30">
                    Última atualização: 20/06/2026
                  </span>

                  <span className="px-3 py-1.5 rounded-full border border-border bg-secondary/30">
                    Aplicável à Vortan Oficina
                  </span>
                </div>
              </div>
            </Card>

            <div className="space-y-4">
              {sections.map((section) => (
                <Card key={section.title} className="p-6 border-red-500/10">
                  <h2 className="text-xl font-semibold text-foreground mb-3">
                    {section.title}
                  </h2>

                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {section.body}
                  </p>
                </Card>
              ))}
            </div>

            <Card className="p-6 border-primary/20">
              <h2 className="text-xl font-semibold mb-3">Contato</h2>

              <p className="text-sm text-muted-foreground leading-relaxed">
                Em caso de dúvidas sobre estes Termos de Uso, entre em contato
                com a equipe Vortan Oficina pelo e-mail{" "}
                <a
                  href="mailto:contato.vortanoficina@gmail.com"
                  className="text-primary hover:underline"
                >
                  contato.vortanoficina@gmail.com
                </a>
                .
              </p>
            </Card>
          </div>

          <div className="lg:sticky lg:top-8 space-y-4">
            <Card className="p-5 border-primary/20">
              <Logo size="sm" />

              <div className="text-center -mt-3">
                <h3 className="font-heading font-bold text-lg">
                  Vortan Oficina
                </h3>

                <p className="text-xs text-muted-foreground mt-1">
                  Gestão completa para oficinas modernas.
                </p>
              </div>
            </Card>

            <Card className="p-5">
              <h3 className="font-semibold mb-4">Resumo rápido</h3>

              <div className="space-y-3">
                {[
                  "Uso profissional da plataforma",
                  "Responsabilidade pelos dados cadastrados",
                  "Acesso vinculado à assinatura ativa",
                  "Termos podem ser atualizados",
                ].map((item) => (
                  <div key={item} className="flex items-start gap-2">
                    <CheckCircle
                      size={15}
                      className="text-primary mt-0.5 flex-shrink-0"
                    />
                    <span className="text-sm text-muted-foreground">
                      {item}
                    </span>
                  </div>
                ))}
              </div>
            </Card>

            <Card className="p-5 bg-red-500/[0.03] border-red-500/20">
              <h3 className="font-semibold mb-2">Precisa de ajuda?</h3>

              <p className="text-xs text-muted-foreground mb-4">
                Fale com o suporte Vortan Oficina pelo WhatsApp.
              </p>

              <Btn
                type="button"
                variant="primary"
                className="w-full justify-center"
                onClick={() =>
                  window.open(
                    "https://wa.me/5527996126147?text=Olá,%20tenho%20uma%20dúvida%20sobre%20os%20Termos%20de%20Uso%20da%20Vortan%20Oficina.",
                    "_blank",
                    "noopener,noreferrer",
                  )
                }
              >
                <MessageCircle size={15} />
                Falar com suporte
              </Btn>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}

function PrivacyPage({ onBack }: { onBack: () => void }) {
  const sections = [
    {
      title: "1. Informações coletadas",
      body: "A Vortan Oficina coleta apenas as informações necessárias para o funcionamento da plataforma, como nome, e-mail, telefone, dados da oficina, clientes, veículos, ordens de serviço e movimentações financeiras cadastradas pelo usuário.",
    },
    {
      title: "2. Uso das informações",
      body: "As informações são utilizadas para permitir o funcionamento do sistema, autenticação de usuários, organização dos dados da oficina, geração de documentos, comunicação com clientes e melhoria da experiência na plataforma.",
    },
    {
      title: "3. Armazenamento e segurança",
      body: "Os dados são armazenados em ambiente online e protegidos por medidas técnicas de segurança. Ainda assim, o usuário também deve proteger seu acesso, mantendo e-mail e senha em segurança.",
    },
    {
      title: "4. Compartilhamento de dados",
      body: "A Vortan Oficina não vende informações dos usuários a terceiros. Dados poderão ser processados por serviços necessários para funcionamento da plataforma, como autenticação, banco de dados, hospedagem e pagamentos.",
    },
    {
      title: "5. Dados cadastrados pelo usuário",
      body: "O usuário é responsável pelas informações inseridas na plataforma, incluindo dados de clientes da oficina, veículos, serviços, valores e observações internas.",
    },
    {
      title: "6. Solicitações e contato",
      body: "O usuário pode entrar em contato com a equipe Vortan Oficina para solicitar informações, correções ou orientações relacionadas aos seus dados e uso da plataforma.",
    },
  ];

  return (
    <div className="min-h-screen text-foreground bg-[#05070A] relative overflow-hidden">
      <div className="fixed left-[-220px] top-1/4 w-[520px] h-[520px] rounded-full bg-red-500/10 blur-[180px] pointer-events-none" />
      <div className="fixed right-[-220px] top-1/3 w-[520px] h-[520px] rounded-full bg-red-500/10 blur-[180px] pointer-events-none" />
      <div className="fixed inset-0 opacity-[0.025] pointer-events-none bg-[linear-gradient(rgba(239,68,68,1)_1px,transparent_1px),linear-gradient(90deg,rgba(239,68,68,1)_1px,transparent_1px)] bg-[size:80px_80px]" />

      <div className="relative max-w-6xl mx-auto px-4 py-8">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-primary transition-colors mb-8"
        >
          <ArrowLeft size={16} />
          Voltar para o início
        </button>

        <div className="grid lg:grid-cols-[1fr_360px] gap-6 items-start">
          <div className="space-y-6">
            <Card className="p-8 border-primary/20 overflow-hidden relative">
              <div className="absolute top-0 right-0 w-60 h-60 bg-red-500/10 blur-[90px] rounded-full pointer-events-none" />

              <div className="relative">
                <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-red-500/20 bg-red-500/10 text-red-400 text-xs font-medium mb-5">
                  <FileText size={14} />
                  Segurança e privacidade
                </div>

                <h1 className="text-4xl md:text-5xl font-bold tracking-tight">
                  Política de Privacidade
                </h1>

                <p className="text-muted-foreground mt-4 text-base max-w-3xl leading-relaxed">
                  Esta Política explica como a Vortan Oficina coleta, utiliza,
                  armazena e protege as informações necessárias para o
                  funcionamento da plataforma.
                </p>

                <div className="mt-6 flex flex-wrap gap-3 text-xs text-muted-foreground">
                  <span className="px-3 py-1.5 rounded-full border border-border bg-secondary/30">
                    Última atualização: 20/06/2026
                  </span>

                  <span className="px-3 py-1.5 rounded-full border border-border bg-secondary/30">
                    Dados da oficina protegidos
                  </span>
                </div>
              </div>
            </Card>

            <div className="space-y-4">
              {sections.map((section) => (
                <Card key={section.title} className="p-6 border-red-500/10">
                  <h2 className="text-xl font-semibold text-foreground mb-3">
                    {section.title}
                  </h2>

                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {section.body}
                  </p>
                </Card>
              ))}
            </div>

            <Card className="p-6 border-primary/20">
              <h2 className="text-xl font-semibold mb-3">Canal de contato</h2>

              <p className="text-sm text-muted-foreground leading-relaxed">
                Para dúvidas relacionadas à privacidade ou dados cadastrados na
                plataforma, entre em contato pelo e-mail{" "}
                <a
                  href="mailto:contato.vortanoficina@gmail.com"
                  className="text-primary hover:underline"
                >
                  contato.vortanoficina@gmail.com
                </a>
                .
              </p>
            </Card>
          </div>

          <div className="lg:sticky lg:top-8 space-y-4">
            <Card className="p-5 border-primary/20">
              <Logo size="sm" />

              <div className="text-center -mt-3">
                <h3 className="font-heading font-bold text-lg">
                  Vortan Oficina
                </h3>

                <p className="text-xs text-muted-foreground mt-1">
                  Seus dados organizados com mais segurança.
                </p>
              </div>
            </Card>

            <Card className="p-5">
              <h3 className="font-semibold mb-4">Compromissos</h3>

              <div className="space-y-3">
                {[
                  "Não vendemos dados dos usuários",
                  "Coletamos apenas o necessário",
                  "Dados usados para operar o sistema",
                  "Usuário controla os dados cadastrados",
                ].map((item) => (
                  <div key={item} className="flex items-start gap-2">
                    <CheckCircle
                      size={15}
                      className="text-primary mt-0.5 flex-shrink-0"
                    />
                    <span className="text-sm text-muted-foreground">
                      {item}
                    </span>
                  </div>
                ))}
              </div>
            </Card>

            <Card className="p-5 bg-red-500/[0.03] border-red-500/20">
              <h3 className="font-semibold mb-2">Dúvidas sobre dados?</h3>

              <p className="text-xs text-muted-foreground mb-4">
                Fale com o suporte Vortan Oficina pelo WhatsApp.
              </p>

              <Btn
                type="button"
                variant="primary"
                className="w-full justify-center"
                onClick={() =>
                  window.open(
                    "https://wa.me/5527996126147?text=Olá,%20tenho%20uma%20dúvida%20sobre%20a%20Política%20de%20Privacidade%20da%20Vortan%20Oficina.",
                    "_blank",
                    "noopener,noreferrer",
                  )
                }
              >
                <MessageCircle size={15} />
                Falar com suporte
              </Btn>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
