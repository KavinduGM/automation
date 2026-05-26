// Per-business service catalogs used by the prompts to ground every blog
// in the brand's actual offerings — so internal links always point to a real
// /services/{slug} page and every article has a defensible CTA target.
//
// Keyed by business.slug. When you onboard a new client, add a row here
// (or later: move to a `BrandKit.services Json` column for full per-tenant
// configurability).

export interface BrandService {
  slug: string;        // matches the site's /services/{slug} route
  title: string;       // human-readable name
  tagline: string;     // 1-line pitch — used to help Claude pick the right service for a topic
  category: "web-development" | "ai-automation";
}

export interface BrandSite {
  domain: string;                  // canonical hostname (no trailing slash)
  brandName: string;               // how the brand refers to itself in copy
  contactPath: string;             // typically "/contact"
  quotePath: string;               // typically "/quote" or "/contact"
  caseStudiesPath: string;         // typically "/portfolio" or "/case-studies"
  services: BrandService[];
}

// GroovyMark WebX — sourced from /Users/kavindugamlath/Desktop/Web Agency Website/lib/services.js
const GROOVYMARK_WEBX: BrandSite = {
  domain: "https://webx.groovymark.com",
  brandName: "GroovyMark WebX",
  contactPath: "/contact",
  quotePath: "/quote",
  caseStudiesPath: "/portfolio",
  services: [
    // Web Development (14)
    { slug: "business-website",     category: "web-development", title: "Business Website",                   tagline: "A polished digital storefront that earns trust on first scroll." },
    { slug: "landing-page",         category: "web-development", title: "Landing Page & Lead Generation",     tagline: "Purpose-built pages engineered around a single conversion goal." },
    { slug: "ecommerce-store",      category: "web-development", title: "eCommerce Store",                    tagline: "Storefronts engineered for conversion, speed, and global scale." },
    { slug: "digital-products-store",category:"web-development", title: "Digital Products Store",             tagline: "A complete storefront for digital goods: instant delivery, licensing, and entitlements." },
    { slug: "b2b-ecommerce",        category: "web-development", title: "B2B eCommerce & Online Ordering",    tagline: "Wholesale ordering portals with tiered pricing, account catalogs, and ERP sync." },
    { slug: "client-portal",        category: "web-development", title: "Custom Client Portal",               tagline: "Branded portals where your clients view, manage, and interact with their accounts." },
    { slug: "booking-system",       category: "web-development", title: "Booking & Appointment System",       tagline: "Online scheduling for services, classes, resources, and multi-location operations." },
    { slug: "invoice-billing",      category: "web-development", title: "Invoice & Billing System",           tagline: "Recurring billing, invoicing, and dunning that runs without you." },
    { slug: "inventory-management", category: "web-development", title: "Inventory & Stock Management",       tagline: "One source of truth for stock across warehouses, channels, and teams." },
    { slug: "pos-system",           category: "web-development", title: "Point of Sale (POS) System",         tagline: "Lightning-fast POS that unifies in-store, online, and back office." },
    { slug: "order-delivery",       category: "web-development", title: "Order & Delivery Management",        tagline: "Order routing, dispatch, and live tracking for delivery operations." },
    { slug: "hr-management",        category: "web-development", title: "HR & Employee Management",           tagline: "A people platform that scales: directory, leave, performance, payroll-ready." },
    { slug: "erp-integration",      category: "web-development", title: "ERP & Legacy System Integration",    tagline: "Web layers, APIs, and integrations that bring legacy systems online safely." },
    { slug: "iot-dashboard",        category: "web-development", title: "Real-Time Operations & IoT Dashboard",tagline:"Operations command centers for live data, devices, and alerting." },

    // AI & Automation (10)
    { slug: "ai-chatbot",                category: "ai-automation", title: "AI Chatbot & Virtual Assistant",       tagline: "Conversational AI trained on your business: answer, qualify, convert." },
    { slug: "ai-lead-qualification",     category: "ai-automation", title: "AI Lead Qualification & CRM Automation",tagline:"Stop reps from working junk leads. AI sorts pipeline before they wake up." },
    { slug: "ai-customer-support",       category: "ai-automation", title: "AI Customer Support Bot",              tagline: "AI support agents that resolve tickets, not just route them." },
    { slug: "ai-document-processing",    category: "ai-automation", title: "AI Document Processing",               tagline: "Turn unstructured documents into clean, validated data, automatically." },
    { slug: "workflow-automation",       category: "ai-automation", title: "Business Process & Workflow Automation",tagline:"Replace email ping-pong and copy-paste work with reliable automations." },
    { slug: "ai-inventory-forecasting",  category: "ai-automation", title: "AI Inventory & Demand Forecasting",    tagline: "Forecasts that beat spreadsheets and explain themselves." },
    { slug: "executive-reporting",       category: "ai-automation", title: "Automated Executive Reporting",        tagline: "Stop building decks. Get narratives, charts, and what-changed-and-why on a schedule." },
    { slug: "predictive-analytics",      category: "ai-automation", title: "Predictive Analytics & BI",            tagline: "BI that doesn't just show the past, it predicts the next quarter." },
    { slug: "ai-hr-recruitment",         category: "ai-automation", title: "AI HR & Recruitment Automation",       tagline: "AI handles funnel volume so recruiters can do the work that matters." },
    { slug: "custom-ai-agent",           category: "ai-automation", title: "Custom AI Agent Development",          tagline: "Agents that plan, act, and check their own work, built around your tools and policies." },
  ],
};

const REGISTRY: Record<string, BrandSite> = {
  "groovymark-webx": GROOVYMARK_WEBX,
};

export function brandSiteFor(slug: string): BrandSite | null {
  return REGISTRY[slug] ?? null;
}

// Compact text block injected into prompts. Lists every service so Claude can
// pick the most relevant one without burning tokens on the full taglines we
// don't need at generation time.
export function brandServicesBlock(slug: string): string {
  const site = brandSiteFor(slug);
  if (!site) return "";
  const lines = site.services.map((s) => `  - "${s.slug}" → ${s.title} — ${s.tagline}`);
  return [
    "<brand_site>",
    `domain: ${site.domain}`,
    `name: ${site.brandName}`,
    `contact: ${site.contactPath}`,
    `quote: ${site.quotePath}`,
    `case_studies: ${site.caseStudiesPath}`,
    "services (slug → title → 1-line):",
    ...lines,
    "</brand_site>",
  ].join("\n");
}
