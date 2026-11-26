/* =====================================================================
   Sakura Beaded Bags - frontend-only version (no server, no database)
   Part 1: local data store + business rules (saved in the browser's localStorage)
   Part 2: the user interface
   ===================================================================== */
const KEY = "sakura_db_v1";
const fresh = () => ({
  _seedVersion: window.SAKURA_DB_SEED ? window.SAKURA_DB_SEED._seedVersion : null,
  seq: {},
  users: [],
  settings: {},
  materials: [],
  log: [],
  products: [],
  customers: [],
  orders: [],
  tx: [],
  uid: null,
});
const stored = JSON.parse(localStorage.getItem(KEY) || "null");
const seed = window.SAKURA_DB_SEED;
const hasBusinessData = (data) =>
  ["materials", "products", "customers", "orders", "tx"].some(
    (key) => Array.isArray(data[key]) && data[key].length > 0,
  );
const useSeed =
  seed &&
  (!stored ||
    (!hasBusinessData(stored) && stored._seedVersion !== seed._seedVersion));
let db = useSeed
  ? {
      ...seed,
      users:
        stored && Array.isArray(stored.users) && stored.users.length
          ? stored.users
          : seed.users,
      uid: stored && stored.uid !== undefined ? stored.uid : seed.uid,
      settings: { ...seed.settings, ...(stored && stored.settings) },
    }
  : stored || seed || fresh();
if (useSeed) localStorage.setItem(KEY, JSON.stringify(db));
const save = () => localStorage.setItem(KEY, JSON.stringify(db));
const nid = (k) => (db.seq[k] = (db.seq[k] || 0) + 1);
const money = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const pad = (p, n, w = 3) => p + String(n).padStart(w, "0");
const bad = (m) => new Error(m);
const now = () => new Date().toISOString();
const hash = (s) => {
  let h1 = 0xdeadbeef,
    h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
};
const okPw = (p) =>
  typeof p === "string" &&
  (p.length >= 15 || (p.length >= 8 && /\d/.test(p) && /[a-z]/.test(p)));
const PW_MSG =
  "Password should be at least 15 characters OR at least 8 characters including a number and a lowercase letter.";
const S = (k, d) => db.settings[k] ?? d;
if (!db.users.length) {
  db.users.push({
    id: nid("user"),
    name: "Administrator",
    email: "admin@sakura.com",
    hash: hash("sakura2026"),
  });
  save();
}
const me = () => db.users.find((u) => u.id === db.uid);
const pub = (u) => ({ id: u.id, name: u.name, email: u.email });

/* ---- inventory ---- */
const mat = (id) => {
  const m = db.materials.find((x) => x.id == id);
  if (!m) throw bad("Material not found");
  return m;
};
const rem = (m) => m.stock_in - m.used;
const matView = (m) => ({
  ...m,
  remaining: rem(m),
  status: rem(m) < m.threshold ? "Low Stock" : "Normal",
});
function stock(m, col, delta, action, reason) {
  const prev = rem(m),
    nv = m[col] + delta,
    res = col === "stock_in" ? nv - m.used : m.stock_in - nv;
  if (res < -1e-9)
    throw bad(
      `Not enough ${m.name} in stock (remaining ${prev}, needed ${money(prev - res)})`,
    );
  m[col] = nv;
  db.log.unshift({
    id: nid("log"),
    ts: now(),
    material_id: m.id,
    material: m.name,
    action,
    net: money(res - prev),
    prev,
    res,
    reason: reason || "",
  });
}

/* ---- products ---- */
function calc(matC, labor, other, method, markup, target) {
  const cost = money(matC + labor + other);
  let sell, profit, pct;
  if (method === "target") {
    sell = money(+target);
    profit = money(sell - cost);
    pct = cost ? (profit / cost) * 100 : 0;
  } else {
    pct = +markup;
    profit = money((cost * pct) / 100);
    sell = money(cost + profit);
  }
  return {
    materialCost: money(matC),
    totalCost: money(cost),
    markupAmount: money(profit),
    markupPct: money(pct),
    sellingPrice: money(sell),
    profit: money(profit),
  };
}
function prodView(p) {
  const bom = p.bom.map((b) => {
    const m = mat(b.material_id);
    return { ...b, name: m.name, unit: m.unit };
  });
  const mc = bom.reduce((s, b) => s + b.qty * b.unit_cost, 0),
    other = p.packaging + p.misc;
  return {
    ...p,
    bom,
    other,
    ...calc(mc, p.labor, other, p.method, p.markup, p.target),
  };
}
function persistProduct(id, b) {
  if (!b.name || !b.name.trim()) throw bad("Product name is required");
  if (!["markup", "target"].includes(b.method))
    throw bad("Select a pricing method");
  if (!Array.isArray(b.bom) || !b.bom.length)
    throw bad("Add at least one material to the BOM");
  for (const l of b.bom)
    if (!(+l.qty > 0) || !(+l.unit_cost >= 0))
      throw bad("Each BOM line needs a quantity and a unit cost");
  if ([b.labor, b.packaging, b.misc, b.markup, b.target].some((v) => +v < 0))
    throw bad("Costs cannot be negative");
  const rec = {
    name: b.name.trim(),
    category: b.category || "",
    image: b.image || "",
    labor: +b.labor || 0,
    packaging: +b.packaging || 0,
    misc: +b.misc || 0,
    method: b.method,
    markup: +b.markup || 0,
    target: +b.target || 0,
    bom: b.bom.map((l) => ({
      material_id: +l.material_id,
      qty: +l.qty,
      unit_cost: +l.unit_cost,
    })),
  };
  let p;
  if (id) {
    p = db.products.find((x) => x.id === id);
    if (!p) throw bad("Product not found");
    Object.assign(p, rec);
  } else {
    p = { id: nid("product"), ...rec };
    db.products.unshift(p);
  }
  return prodView(p);
}

/* ---- orders & payments ---- */
const paidOf = (oid) =>
  db.tx.filter((t) => t.slip_id === oid).reduce((s, t) => s + t.amount, 0);
const getOrder = (id) => {
  const o = db.orders.find((x) => x.id == id);
  if (!o) throw bad("Order not found");
  return o;
};
function orderView(o) {
  const c = db.customers.find((x) => x.id === o.customer_id),
    paid = paidOf(o.id);
  return {
    ...JSON.parse(JSON.stringify(o)),
    code: pad("ORD-", o.id),
    customer: { ...c, code: pad("CUS", c.id) },
    slipId: o.id,
    slipCode: pad("SLP", o.id),
    paid,
    balance: money(o.total - paid),
  };
}
function syncPayment(o) {
  const paid = paidOf(o.id);
  o.payment =
    paid <= 0
      ? "Pending"
      : o.total - paid <= 0.005
        ? "Fully Paid"
        : "Downpayment";
}

/* ---- reports ---- */
function report(from, to, group) {
  const inRange = (d) =>
    (!from || d.slice(0, 10) >= from) && (!to || d.slice(0, 10) <= to);
  const all = db.orders
      .slice()
      .sort((a, b) => a.id - b.id)
      .map(orderView),
    first = {};
  for (const o of all)
    if (!o.cancelled && !first[o.customer_id]) first[o.customer_id] = o.created;
  const live = all.filter((o) => !o.cancelled && inRange(o.created));
  let sales = 0,
    m_ = 0,
    lab = 0,
    outstanding = 0;
  const series = {},
    prod = {},
    cust = {},
    pay = { Pending: 0, Downpayment: 0, "Fully Paid": 0 },
    newC = new Set(),
    retC = new Set();
  for (const o of live) {
    const k = group === "day" ? o.created.slice(0, 10) : o.created.slice(0, 7);
    const s =
      series[k] || (series[k] = { period: k, sales: 0, material: 0, labor: 0 });
    s.sales += o.total;
    sales += o.total;
    pay[o.payment]++;
    outstanding += o.balance;
    for (const i of o.items) {
      const m = i.mat_cost * i.qty,
        l = i.labor_cost * i.qty,
        r = i.price * i.qty;
      m_ += m;
      lab += l;
      s.material += m;
      s.labor += l;
      const p =
        prod[i.name] ||
        (prod[i.name] = { name: i.name, qty: 0, sales: 0, profit: 0 });
      p.qty += i.qty;
      p.sales += r;
      p.profit += r - m - l;
    }
    const c =
      cust[o.customer_id] ||
      (cust[o.customer_id] = { name: o.customer.name, orders: 0, revenue: 0 });
    c.orders++;
    c.revenue += o.total;
    (inRange(first[o.customer_id]) ? newC : retC).add(o.customer_id);
  }
  const cashIn = db.tx
    .filter((t) => inRange(t.ts))
    .reduce((s, t) => s + t.amount, 0);
  const refunds = all
    .filter((o) => o.cancelled && inRange(o.created))
    .reduce((s, o) => s + o.refund, 0);
  const r2 = (o) =>
    Object.fromEntries(
      Object.entries(o).map(([k, v]) => [
        k,
        typeof v === "number" ? money(v) : v,
      ]),
    );
  const profit = sales - m_ - lab;
  return {
    kpi: r2({
      sales,
      material: m_,
      labor: lab,
      profit,
      margin: sales ? (profit / sales) * 100 : 0,
      materialPct: sales ? (m_ / sales) * 100 : 0,
      laborPct: sales ? (lab / sales) * 100 : 0,
      orders: live.length,
    }),
    series: Object.values(series)
      .sort((a, b) => a.period.localeCompare(b.period))
      .map((s) => r2({ ...s, profit: s.sales - s.material - s.labor })),
    topBySales: Object.values(prod)
      .sort((a, b) => b.sales - a.sales)
      .slice(0, 5)
      .map(r2),
    topByProfit: Object.values(prod)
      .sort((a, b) => b.profit - a.profit)
      .slice(0, 5)
      .map(r2),
    topCustomers: Object.values(cust)
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5)
      .map(r2),
    customers: {
      new: newC.size,
      returning: retC.size,
      total: newC.size + retC.size,
    },
    payments: pay,
    cash: r2({ cashIn, refunds, net: cashIn - refunds, outstanding }),
  };
}

/* ---- the "API": same calls the UI makes, answered locally ---- */
const routes = [],
  on = (m, re, fn) => routes.push([m, re, fn]);
const PUBLIC = /^\/api\/(login|register|forgot|verify|reset|logout)$/;

on("POST", /^\/api\/register$/, (b) => {
  if (!b.name || !b.email) throw bad("Name and email are required");
  if (!okPw(b.password)) throw bad(PW_MSG);
  const email = b.email.toLowerCase().trim();
  if (db.users.some((u) => u.email === email))
    throw bad("Email is already registered");
  const u = {
    id: nid("user"),
    name: b.name.trim(),
    email,
    hash: hash(b.password),
  };
  db.users.push(u);
  db.uid = u.id;
  return pub(u);
});
on("POST", /^\/api\/login$/, (b) => {
  const u = db.users.find(
    (x) => x.email === (b.email || "").toLowerCase().trim(),
  );
  if (!u || u.hash !== hash(b.password || ""))
    throw bad("Invalid email or password");
  db.uid = u.id;
  return pub(u);
});
on("POST", /^\/api\/logout$/, () => {
  db.uid = null;
  return { ok: true };
});
on("GET", /^\/api\/me$/, () => pub(me()));
// No email server in this version, so the code is returned and shown on screen (demo only).
on("POST", /^\/api\/forgot$/, (b) => {
  const u = db.users.find(
    (x) => x.email === (b.email || "").toLowerCase().trim(),
  );
  if (!u) return { ok: true };
  u.reset_code = String(Math.floor(100000 + Math.random() * 900000));
  u.reset_exp = Date.now() + 10 * 60000;
  u.reset_ok = false;
  return { ok: true, demoCode: u.reset_code };
});
on("POST", /^\/api\/verify$/, (b) => {
  const u = db.users.find((x) => x.email === (b.email || "").toLowerCase());
  if (
    !u ||
    !u.reset_code ||
    u.reset_exp < Date.now() ||
    u.reset_code !== String(b.code || "")
  )
    throw bad("Invalid or expired code");
  u.reset_ok = true;
  u.reset_exp = Date.now() + 10 * 60000;
  return { ok: true };
});
on("POST", /^\/api\/reset$/, (b) => {
  const u = db.users.find((x) => x.email === (b.email || "").toLowerCase());
  if (!u || !u.reset_ok || u.reset_exp < Date.now())
    throw bad("Reset session expired. Please start again.");
  if (!okPw(b.password)) throw bad(PW_MSG);
  if (u.hash === hash(b.password))
    throw bad(
      "Your new password must be different from your previous password.",
    );
  u.hash = hash(b.password);
  delete u.reset_code;
  delete u.reset_exp;
  u.reset_ok = false;
  return { ok: true };
});

on("GET", /^\/api\/settings$/, () => ({
  dp_percent: S("dp_percent", 50),
  methods: S("methods", ["GCash"]),
}));
on("PUT", /^\/api\/settings$/, (b) => {
  if (b.dp_percent !== undefined) {
    const d = +b.dp_percent;
    if (!(d > 0 && d <= 100))
      throw bad("Downpayment % must be between 1 and 100");
    db.settings.dp_percent = d;
  }
  if (b.methods) {
    const m = [
      ...new Set(b.methods.map((x) => String(x).trim()).filter(Boolean)),
    ];
    if (!m.length) throw bad("At least one payment method is required");
    db.settings.methods = m;
  }
  return { dp_percent: S("dp_percent", 50), methods: S("methods", ["GCash"]) };
});

on("GET", /^\/api\/materials$/, () =>
  db.materials
    .filter((m) => !m.deleted)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(matView),
);
on("POST", /^\/api\/materials$/, (b) => {
  if (!b.name || !b.unit) throw bad("Material name and unit are required");
  if (+b.qty < 0 || +b.threshold < 0)
    throw bad("Quantities cannot be negative");
  if (
    db.materials.some(
      (m) => !m.deleted && m.name.toLowerCase() === b.name.trim().toLowerCase(),
    )
  )
    throw bad("Material already exists");
  const m = {
    id: nid("material"),
    name: b.name.trim(),
    unit: b.unit.trim(),
    stock_in: 0,
    used: 0,
    threshold: +b.threshold || 0,
  };
  db.materials.push(m);
  if (+b.qty > 0)
    stock(m, "stock_in", +b.qty, "Stock In", b.reason || "Initial stock");
  return { ok: true };
});
on("PUT", /^\/api\/materials\/(\d+)$/, (b, q, id) => {
  if (!b.name || !b.unit || +b.threshold < 0)
    throw bad("Invalid material details");
  const m = mat(id);
  if (m.deleted) throw bad("Deleted materials cannot be edited");
  Object.assign(m, {
    name: b.name.trim(),
    unit: b.unit.trim(),
    threshold: +b.threshold,
  });
  return { ok: true };
});
on("DELETE", /^\/api\/materials\/(\d+)$/, (b, q, id) => {
  const m = mat(id),
    reason = String(b.reason || "").trim();
  if (m.deleted) throw bad("Material is already deleted");
  if (!reason) throw bad("Enter a reason for deleting this material");
  const remaining = money(rem(m));
  db.log.unshift({
    id: nid("log"),
    ts: now(),
    material_id: m.id,
    material: m.name,
    action: "Deleted",
    net: money(-remaining),
    prev: remaining,
    res: 0,
    reason,
  });
  m.deleted = true;
  m.deleted_at = now();
  return { ok: true };
});
on("POST", /^\/api\/materials\/(\d+)\/stock$/, (b, q, id) => {
  const n = +b.qty;
  if (!(n > 0)) throw bad("Enter a quantity greater than zero");
  if (b.type === "in")
    stock(mat(id), "stock_in", n, "Stock In", b.reason || "Restocking");
  else if (b.type === "out")
    stock(mat(id), "used", n, "Stock Out", b.reason || "Stock correction");
  else throw bad("Invalid stock action");
  return { ok: true };
});
on("GET", /^\/api\/inventory-log$/, () => db.log.slice(0, 300));

on("GET", /^\/api\/products$/, () => db.products.map(prodView));
on("POST", /^\/api\/products$/, (b) => persistProduct(0, b));
on("PUT", /^\/api\/products\/(\d+)$/, (b, q, id) => persistProduct(+id, b));
on("POST", /^\/api\/products\/delete-many$/, (b) => {
  const ids = (b.ids || []).map(Number);
  db.products = db.products.filter((p) => !ids.includes(p.id));
  return { deleted: ids.length };
});

on("GET", /^\/api\/orders$/, () =>
  db.orders
    .slice()
    .sort((a, b) => a.created.localeCompare(b.created) || a.id - b.id)
    .map(orderView),
); // FIFO
on("GET", /^\/api\/orders\/(\d+)$/, (b, q, id) => orderView(getOrder(id)));
on("POST", /^\/api\/orders$/, (b) => {
  const c = b.customer || {},
    items = b.items || [];
  if (!c.name || !c.address || !c.contact)
    throw bad(
      "Customer name, shipping address and contact number are required",
    );
  if (!items.length) throw bad("Add at least one product");
  let cu = db.customers.find(
    (x) => x.name === c.name.trim() && x.contact === c.contact.trim(),
  );
  if (cu) cu.address = c.address.trim();
  else {
    cu = {
      id: nid("customer"),
      name: c.name.trim(),
      address: c.address.trim(),
      contact: c.contact.trim(),
    };
    db.customers.push(cu);
  }
  const o = {
    id: nid("order"),
    created: now(),
    customer_id: cu.id,
    total: 0,
    production: "Pending",
    delivery: "Pending",
    payment: "Pending",
    deducted: 0,
    cancelled: 0,
    refund: 0,
    items: [],
  };
  let total = 0;
  for (const it of items) {
    const p = db.products.find((x) => x.id == it.product_id);
    if (!p) throw bad("Product not found");
    const qty = Math.floor(+it.qty);
    if (!(qty >= 1)) throw bad("Quantity must be at least 1");
    const v = prodView(p);
    o.items.push({
      id: nid("item"),
      product_id: p.id,
      name: p.name,
      qty,
      price: v.sellingPrice,
      mat_cost: v.materialCost,
      labor_cost: p.labor,
      other_cost: v.other,
      bom: v.bom.map((x) => ({
        material_id: x.material_id,
        name: x.name,
        qty: x.qty,
        unit_cost: x.unit_cost,
      })),
    });
    total += v.sellingPrice * qty;
  }
  o.total = money(total);
  db.orders.push(o);
  return orderView(o);
});
on("PUT", /^\/api\/orders\/(\d+)\/status$/, (b, q, id) => {
  const o = getOrder(id);
  if (o.cancelled) throw bad("Order is cancelled");
  const PR = ["Pending", "In Progress", "Completed"],
    DL = ["Pending", "Shipped", "Delivered"];
  const production = b.production || o.production,
    delivery = b.delivery || o.delivery;
  if (!PR.includes(production) || !DL.includes(delivery))
    throw bad("Invalid status");
  if (PR.indexOf(production) < PR.indexOf(o.production))
    throw bad(
      "Production cannot move backwards. Cancel the order to restore stock.",
    );
  if (delivery !== "Pending" && production !== "Completed")
    throw bad("Production must be Completed before shipping");
  if (DL.indexOf(delivery) < DL.indexOf(o.delivery))
    throw bad("Delivery cannot move backwards");
  if (production !== "Pending" && !o.deducted) {
    // deduct inventory once production starts
    for (const it of o.items)
      for (const bl of it.bom)
        stock(
          mat(bl.material_id),
          "used",
          bl.qty * it.qty,
          "Stock Out",
          `Production started for ${pad("ORD-", o.id)}`,
        );
    o.deducted = 1;
  }
  o.production = production;
  o.delivery = delivery;
  return orderView(o);
});
on("PUT", /^\/api\/orders\/(\d+)\/items\/(\d+)\/bom$/, (b, q, id, iid) => {
  const o = getOrder(id);
  if (o.cancelled) throw bad("Order is cancelled");
  if (o.deducted) throw bad("BOM is locked because production has started");
  const it = o.items.find((x) => x.id == iid),
    lines = b.lines || [];
  if (!lines.length) throw bad("The BOM must contain at least one material");
  for (const l of lines)
    if (!(+l.qty > 0) || !(+l.unit_cost >= 0))
      throw bad("Each line needs a quantity and unit cost");
  it.bom = lines.map((l) => ({
    material_id: mat(l.material_id).id,
    name: mat(l.material_id).name,
    qty: +l.qty,
    unit_cost: +l.unit_cost,
  }));
  it.mat_cost = money(it.bom.reduce((s, l) => s + l.qty * l.unit_cost, 0));
  const product = db.products.find((p) => p.id == it.product_id);
  if (product) {
    const unitCost = money(it.mat_cost + it.labor_cost + it.other_cost);
    if (product.method === "target") {
      it.price = money(+product.target);
    } else {
      it.price = money(unitCost * (1 + (+product.markup || 0) / 100));
    }
  }
  o.total = money(
    o.items.reduce((sum, item) => sum + item.price * item.qty, 0),
  );
  syncPayment(o);
  return orderView(o);
});
on("POST", /^\/api\/orders\/(\d+)\/cancel$/, (b, q, id) => {
  const o = getOrder(id);
  if (o.cancelled) throw bad("Order is already cancelled");
  const refund = money(+b.refund || 0),
    paid = paidOf(o.id);
  if (refund < 0 || refund > paid)
    throw bad(`Refund must be between 0 and the amount paid (${paid})`);
  if (o.deducted)
    for (const it of o.items)
      for (const bl of it.bom)
        stock(
          mat(bl.material_id),
          "used",
          -(bl.qty * it.qty),
          "Stock In (Restored)",
          `${pad("ORD-", o.id)} cancelled`,
        );
  o.cancelled = 1;
  o.deducted = 0;
  o.refund = refund;
  return orderView(o);
});

on("GET", /^\/api\/payments$/, () =>
  db.orders
    .slice()
    .sort((a, b) => b.id - a.id)
    .map(orderView)
    .map((o) => {
      const last = db.tx.filter((t) => t.slip_id === o.id).pop();
      return {
        slipId: o.slipId,
        slipCode: o.slipCode,
        orderCode: o.code,
        customer: o.customer.name,
        customerCode: o.customer.code,
        total: o.total,
        paid: o.paid,
        balance: o.balance,
        date: last ? last.ts : o.created,
        status: o.payment,
        cancelled: o.cancelled,
      };
    }),
);
on("GET", /^\/api\/payments\/(\d+)$/, (b, q, sid) => {
  const o = orderView(getOrder(sid));
  return {
    slipId: o.id,
    slipCode: o.slipCode,
    orderCode: o.code,
    customer: o.customer,
    total: o.total,
    paid: o.paid,
    balance: o.balance,
    status: o.payment,
    cancelled: o.cancelled,
    suggestedDp: money((o.total * S("dp_percent", 50)) / 100),
    methods: S("methods", ["GCash"]),
    transactions: db.tx
      .filter((t) => t.slip_id === o.id)
      .map((t) => ({ ...t, code: pad("T", t.id) })),
  };
});
on("POST", /^\/api\/payments\/(\d+)$/, (b, q, sid) => {
  const o = getOrder(sid);
  if (o.cancelled) throw bad("Order is cancelled");
  const method = b.method || "GCash",
    ref = String(b.ref || "").trim(),
    amt = money(+b.amount),
    bal = money(o.total - paidOf(o.id));
  if (!["Downpayment", "Full Payment"].includes(b.type))
    throw bad("Select a payment option");
  if (!(amt > 0)) throw bad("Enter a valid amount");
  if (bal <= 0) throw bad("This order is already fully paid");
  if (amt > bal) throw bad(`Amount exceeds the remaining balance of ${bal}`);
  if (b.type === "Full Payment" && amt !== bal)
    throw bad(`Full payment must equal the remaining balance (${bal})`);
  if (!S("methods", ["GCash"]).includes(method))
    throw bad("Unknown payment method");
  if (method === "GCash") {
    if (!/^\d{10,15}$/.test(ref))
      throw bad("Enter a valid GCash reference number (10-15 digits)");
    if (db.tx.some((t) => t.method === method && t.ref === ref))
      throw bad("This GCash reference has already been recorded");
  }
  db.tx.push({
    id: nid("tx"),
    slip_id: o.id,
    type: b.type,
    amount: amt,
    method,
    ref,
    ts: now(),
  });
  syncPayment(o);
  return { ok: true };
});

on("GET", /^\/api\/reports$/, (b, q) => report(q.from, q.to, q.group));
on("GET", /^\/api\/dashboard$/, () => {
  const r = report("", "", "month");
  return {
    kpi: r.kpi,
    series: r.series,
    recent: db.orders
      .filter((o) => !o.cancelled)
      .sort((a, b) => b.id - a.id)
      .slice(0, 5)
      .map(orderView),
    alerts: db.materials
      .filter((m) => !m.deleted)
      .map(matView)
      .filter((m) => m.status === "Low Stock"),
  };
});

async function api(url, method = "GET", body) {
  const [path, qs] = url.split("?"),
    q = Object.fromEntries(new URLSearchParams(qs || ""));
  const hit = routes.find(([m, re]) => m === method && re.test(path));
  if (!hit) throw new Error("Not found: " + path);
  if (!PUBLIC.test(path) && !me()) {
    if (user) {
      user = null;
      route();
    }
    throw new Error("Please log in");
  }
  const snapshot = JSON.stringify(db); // all-or-nothing, like a database transaction
  try {
    const out = hit[2](body || {}, q, ...path.match(hit[1]).slice(1));
    save();
    return JSON.parse(JSON.stringify(out ?? null));
  } catch (e) {
    db = JSON.parse(snapshot);
    throw e;
  }
}

/* ===================== PART 2: USER INTERFACE ===================== */
const $ = (s) => document.querySelector(s);
const renderTemplate = (templateId, targetId) => {
  const template = $("#" + templateId);
  if (!template) throw new Error("Missing HTML template: " + templateId);
  const target = $("#" + targetId);
  target.replaceChildren(template.content.cloneNode(true));
  return target;
};
const templateMarkup = (templateId) => {
  const template = $("#" + templateId);
  if (!template) throw new Error("Missing HTML template: " + templateId);
  return template.innerHTML;
};
const renderAuthTemplate = (viewName) => {
  $("#app").replaceChildren();
  const appTemplate = $("#auth-template");
  $("#app").append(appTemplate.content.cloneNode(true));
  const form = $("#app .auth-form");
  const pageTemplate = $("#auth-" + viewName + "-template");
  form.replaceChildren(pageTemplate.content.cloneNode(true));
  if (viewName === "verify") $("#auth-email").textContent = authEmail;
};
window.togglePassword = (button) => {
  const input = button.previousElementSibling;
  input.type = input.type === "password" ? "text" : "password";
  const icon = button.querySelector("i");
  icon.className = input.type === "password" ? "bi bi-eye" : "bi bi-eye-slash";
  button.setAttribute(
    "aria-label",
    input.type === "password" ? "Show password" : "Hide password",
  );
};
window.otpInput = (input) => {
  input.value = input.value.replace(/\D/g, "");
  if (input.value) input.nextElementSibling?.focus();
};
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const peso = (n) =>
  "₱" +
  (+n || 0).toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
const dt = (s) =>
  s
    ? new Date(s).toLocaleString("en-PH", {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "";
const d10 = (s) => (s ? new Date(s).toLocaleDateString("en-CA") : "");
const val = (id) => $("#" + id).value;
const num = (id) => +val(id) || 0;
const badge = (s) =>
  `<span class="badge ${esc(String(s).split(" ")[0])}">${esc(s)}</span>`;
const sel = (list, cur) =>
  list
    .map((x) => `<option ${x === cur ? "selected" : ""}>${esc(x)}</option>`)
    .join("");
const stat = (k, v) => `<div class="card"><small>${k}</small><b>${v}</b></div>`;
const bars = (pairs) => {
  const mx = Math.max(1, ...pairs.map((p) => p[1]));
  return pairs.length
    ? `<div class="bars">${pairs.map(([l, v]) => `<div class="bar" title="${peso(v)}"><i style="height:${(v / mx) * 90}%"></i><span>${esc(l)}</span></div>`).join("")}</div>`
    : '<p class="empty">No data for this period.</p>';
};

function toast(m, err) {
  const t = $("#toast");
  t.textContent = m;
  t.className = "show" + (err ? " err" : "");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.className = ""), 3200);
}
const modal = (html, wide) => {
  $("#modal").innerHTML =
    `<div class="box ${wide ? "wide" : ""}">${html}</div>`;
  $("#modal").classList.remove("hidden");
};
const H = (o) =>
  Object.entries(o).forEach(
    ([k, f]) =>
      (window[k] = async (...a) => {
        try {
          return await f(...a);
        } catch (e) {
          toast(e.message, true);
        }
      }),
  );
const done = (title, msg, fn = "closeModal()") =>
  modal(
    `<div class="center"><div class="status-icon"><i class="bi bi-check-circle-fill"></i></div><h2>${title}</h2><p>${msg || ""}</p><button class="btn" onclick="${fn}">Done</button></div>`,
  );

let user = null,
  view = "dashboard",
  authView = "login",
  authEmail = "",
  alertsN = 0;
const V = {},
  AFTER = {},
  P = { bom: [], editing: null, sel: new Set(), image: "" },
  O = { arch: false, cart: {} },
  I = {},
  R = {};

/* ---------------- AUTH ---------------- */
H({
  setAuth: (v) => {
    authView = v;
    route();
  },
  login: async () => {
    user = await api("/api/login", "POST", {
      email: val("e"),
      password: val("p"),
    });
    view = "dashboard";
    route();
  },
  signup: async () => {
    user = await api("/api/register", "POST", {
      name: val("n"),
      email: val("e"),
      password: val("p"),
    });
    view = "dashboard";
    route();
  },
  forgot: async (email) => {
    authEmail = typeof email === "string" ? email : val("e");
    const fr = await api("/api/forgot", "POST", { email: authEmail });
    if (fr.demoCode)
      alert(
        "Demo mode (no email server): your verification code is " + fr.demoCode,
      );
    if (authView !== "verify") {
      authView = "verify";
      route();
    } else toast("A new code was sent");
  },
  verify: async () => {
    await api("/api/verify", "POST", {
      email: authEmail,
      code: [...document.querySelectorAll(".otp")].map((i) => i.value).join(""),
    });
    toast("Code Verified");
    authView = "reset";
    route();
  },
  reset: async () => {
    if (val("p") !== val("p2")) throw new Error("Passwords do not match");
    await api("/api/reset", "POST", { email: authEmail, password: val("p") });
    authView = "done";
    route();
  },
  logout: async () => {
    await api("/api/logout", "POST");
    user = null;
    authView = "login";
    route();
  },
  closeModal: () => $("#modal").classList.add("hidden"),
  nav: (v) => {
    view = v;
    route();
  },
});

/* ---------------- SHELL ---------------- */
const NAV = [
  ["dashboard", "Dashboard", "grid"],
  ["products", "Products", "bag"],
  ["inventory", "Inventory", "boxes"],
  ["payments", "Payment & Sales", "credit-card"],
  ["orders", "Orders", "cart"],
  ["reports", "Reports", "graph-up"],
  ["settings", "Settings", "gear"],
];
async function route() {
  if (!user) {
    renderAuthTemplate(authView);
    return;
  }
  try {
    alertsN = (await api("/api/materials")).filter(
      (m) => m.status === "Low Stock",
    ).length;
  } catch {}
  renderTemplate("shell-template", "app");
  $("#app .user-name").textContent = user.name;
  $("#app .bell-count").textContent = alertsN;
  $("#app .bell-count").classList.toggle("hidden", !alertsN);
  $("#main-nav").innerHTML = NAV.map(
    (n) =>
      `<a class="${view === n[0] ? "on" : ""}" onclick="nav('${n[0]}')"><i class="bi bi-${n[2]}"></i>${n[1]}</a>`,
  ).join("");
  await renderView();
}
async function renderView() {
  try {
    $("#main").innerHTML = await V[view]();
    if (AFTER[view]) AFTER[view]();
  } catch (e) {
    toast(e.message, true);
  }
}
window.renderView = renderView;
window.filterRows = (q) =>
  document
    .querySelectorAll("#main tbody tr")
    .forEach(
      (r) =>
        (r.style.display = r.textContent.toLowerCase().includes(q.toLowerCase())
          ? ""
          : "none"),
    );

/* ---------------- DASHBOARD ---------------- */
V.dashboard = async () => {
  const d = await api("/api/dashboard"),
    k = d.kpi;
  return `<h1>Dashboard</h1><br><div class="cards">${stat("Total Sales", peso(k.sales))}${stat("Material Expense", peso(k.material))}${stat("Labor Expense", peso(k.labor))}${stat("Gross Profit", peso(k.profit))}</div>
  <div class="panel"><h3>Recent Orders</h3>${d.recent.length ? `<table><thead><tr><th>Order ID<th>Customer<th>Total<th>Status</tr></thead><tbody>${d.recent.map((o) => `<tr><td>${o.code}<td>${esc(o.customer.name)}<td>${peso(o.total)}<td>${badge(o.payment)}`).join("")}</tbody></table>` : '<p class="empty">No orders yet.</p>'}</div>
  <div class="two"><div class="panel"><h3>Inventory Alerts</h3>${d.alerts.map((m) => `<div class="alert">⚠ ${esc(m.name)}: ${m.remaining} ${esc(m.unit)} left (threshold ${m.threshold})</div>`).join("") || '<p class="muted">All materials are above their thresholds.</p>'}</div>
  <div class="panel"><h3>Sales Overview</h3>${bars(d.series.map((s) => [s.period, s.sales]))}</div></div>`;
};

/* ---------------- PRODUCTS ---------------- */
const calcP = (mat, labor, other, m, mk, tg) => {
  const cost = money(mat + labor + other);
  let sell, profit, pct;
  if (m === "target") {
    sell = money(tg);
    profit = money(sell - cost);
    pct = cost ? (profit / cost) * 100 : 0;
  } else {
    pct = mk;
    profit = money((cost * pct) / 100);
    sell = money(cost + profit);
  }
  return { cost, profit, pct, sell };
};
V.products = async () => {
  [P.mats, P.prods] = await Promise.all([
    api("/api/materials"),
    api("/api/products"),
  ]);
  P.sel = new Set();
  return templateMarkup("product-page-template");
};
AFTER.products = () => {
  $("#bm").innerHTML = P.mats
    .map(
      (m) => `<option value="${m.id}">${esc(m.name)} (${esc(m.unit)})</option>`,
    )
    .join("");
  if (!P.prods.length) {
    $("#product-empty").textContent =
      "There are no products in the database yet. Fill out the BOM and pricing strategy below to add your first product.";
  } else {
    $("#product-empty").remove();
  }
  if (!P.mats.length) {
    $("#inventory-empty").textContent =
      "Add materials in Inventory first so they can be used in a Bill of Materials.";
  } else {
    $("#inventory-empty").remove();
  }
  $("#product-catalog").innerHTML = P.prods.length
    ? P.prods
        .map(
          (p) =>
            `<tr><td><input type="checkbox" class="sc" style="width:auto" onchange="toggleSel(${p.id},this.checked)"></td><td>${p.image ? `<img src="${p.image}">` : ""}</td><td>${esc(p.name)}</td><td>${esc(p.category)}</td><td>${peso(p.materialCost)}</td><td>${peso(p.totalCost)}</td><td>${peso(p.sellingPrice)}</td><td>${peso(p.profit)}</td><td><button class="btn sm" onclick="editProduct(${p.id})">Edit / Recalculate</button> <button class="btn sm ghost" aria-label="Delete product" onclick="delOne(${p.id})"><i class="bi bi-trash"></i></button></td></tr>`,
        )
        .join("")
    : '<tr><td colspan="9" class="empty">No products listed here yet.</td></tr>';
  renderBom();
  recalc();
};
function renderBom() {
  $("#bomt").innerHTML =
    P.bom
      .map((b, i) => {
        const m = P.mats.find((x) => x.id == b.material_id) || {};
        return `<tr><td>${esc(m.name)}<td>${b.qty}<td>${peso(b.unit_cost)}<td>${peso(b.qty * b.unit_cost)}<td><button class="btn sm ghost" aria-label="Remove material" onclick="rmBom(${i})"><i class="bi bi-x-lg"></i></button>`;
      })
      .join("") ||
    '<tr><td colspan="5" class="muted">No materials added yet.</td></tr>';
}
function recalc() {
  if (!$("#sum")) return;
  const mat = money(P.bom.reduce((s, b) => s + b.qty * b.unit_cost, 0)),
    labor = num("pl"),
    packaging = num("pk"),
    miscellaneous = num("pm"),
    m = val("mt");
  $("#mkl").classList.toggle("hidden", m === "target");
  $("#tgl").classList.toggle("hidden", m !== "target");
  const c = calcP(
    mat,
    labor,
    packaging + miscellaneous,
    m,
    num("mk"),
    num("tg"),
  );
  $("#sum").innerHTML =
    `<dt>Total Material Cost<dd>${peso(mat)}<dt>Labor Expense<dd>${peso(labor)}<dt>Packaging<dd>${peso(packaging)}<dt>Miscellaneous<dd>${peso(miscellaneous)}<dt><b>Total Product Cost</b><dd><b>${peso(c.cost)}</b><dt>${m === "target" ? "Effective Markup" : "Markup Rate"}<dd>${c.pct.toFixed(2)}%<dt>Profit per Unit<dd>${peso(c.profit)}<dt><b>Unit Selling Price</b><dd><b>${peso(c.sell)}</b>`;
}
function selbar() {
  $("#selbar").innerHTML = P.sel.size
    ? `<div class="panel between"><b>${P.sel.size} Selected</b><button class="btn danger" onclick="confirmDel()">Delete</button></div>`
    : "";
}
H({
  addBom: () => {
    const mid = +val("bm"),
      q = num("bq");
    if (!mid) throw new Error("Select a material");
    if (!(q > 0)) throw new Error("Enter the quantity used");
    if (P.bom.some((b) => b.material_id === mid))
      throw new Error("Material is already in the BOM");
    P.bom.push({ material_id: mid, qty: q, unit_cost: num("bu") });
    $("#bq").value = "";
    $("#bu").value = "";
    renderBom();
    recalc();
  },
  rmBom: (i) => {
    P.bom.splice(i, 1);
    renderBom();
    recalc();
  },
  newProduct: () => {
    P.editing = null;
    P.bom = [];
    P.image = "";
    renderView();
  },
  editProduct: (id) => {
    const p = P.prods.find((x) => x.id === id);
    P.editing = id;
    P.image = p.image;
    P.bom = p.bom.map((b) => ({
      material_id: b.material_id,
      qty: b.qty,
      unit_cost: b.unit_cost,
    }));
    Object.entries({
      pn: p.name,
      pc: p.category,
      pl: p.labor,
      pk: p.packaging,
      pm: p.misc,
      mt: p.method,
      mk: p.markup,
      tg: p.method === "target" ? p.target : p.sellingPrice,
    }).forEach(([k, v]) => ($("#" + k).value = v));
    renderBom();
    recalc();
    window.scrollTo({ top: 0, behavior: "smooth" });
    toast(`Editing "${p.name}" - change values then press Save to recalculate`);
  },
  saveProduct: async () => {
    let image = P.image || "";
    const f = $("#pi").files[0];
    if (f) {
      if (f.size > 2e6) throw new Error("Image must be under 2 MB");
      image = await new Promise((r) => {
        const fr = new FileReader();
        fr.onload = () => r(fr.result);
        fr.readAsDataURL(f);
      });
    }
    const p = await api(
      P.editing ? "/api/products/" + P.editing : "/api/products",
      P.editing ? "PUT" : "POST",
      {
        name: val("pn"),
        category: val("pc"),
        image,
        labor: num("pl"),
        packaging: num("pk"),
        misc: num("pm"),
        method: val("mt"),
        markup: num("mk"),
        target: num("tg"),
        bom: P.bom,
      },
    );
    P.editing = null;
    P.bom = [];
    P.image = "";
    await renderView();
    toast(`"${p.name}" is saved successfully`);
  },
  toggleSel: (id, on) => {
    on ? P.sel.add(id) : P.sel.delete(id);
    selbar();
  },
  selAll: (on) => {
    P.sel = new Set(on ? P.prods.map((p) => p.id) : []);
    document.querySelectorAll(".sc").forEach((c) => (c.checked = on));
    selbar();
  },
  delOne: (id) => {
    P.sel = new Set([id]);
    confirmDel();
  },
  confirmDel: () =>
    modal(
      `<h2>Delete ${P.sel.size === P.prods.length && P.sel.size > 1 ? "all products" : P.sel.size + " product(s)"}</h2><p>Are you sure you want to delete ${P.sel.size === P.prods.length && P.sel.size > 1 ? "all products in the database" : "the selected product(s)"}? This action cannot be undone.</p><div class="btns"><button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn danger" onclick="doDel()">Delete</button></div>`,
    ),
  doDel: async () => {
    await api("/api/products/delete-many", "POST", { ids: [...P.sel] });
    closeModal();
    await renderView();
    toast("Product(s) deleted successfully");
  },
});

/* ---------------- INVENTORY ---------------- */
V.inventory = async () => {
  const [ms, lg] = await Promise.all([
    api("/api/materials"),
    api("/api/inventory-log"),
  ]);
  I.mats = ms;
  I.log = lg;
  return templateMarkup("inventory-page-template");
};
AFTER.inventory = () => {
  $("#inventory-empty").classList.toggle("hidden", I.mats.length > 0);
  $("#inventory-table").classList.toggle("hidden", I.mats.length === 0);
  $("#inventory-rows").innerHTML = I.mats
    .map(
      (m) =>
        `<tr><td>${esc(m.name)}</td><td>${esc(m.unit)}</td><td>${m.stock_in}</td><td>${m.used}</td><td><b>${m.remaining}</b></td><td>${m.threshold}</td><td>${badge(m.status)}</td><td><button class="btn sm" onclick="stockModal(${m.id},'in')">Stock In</button> <button class="btn sm ghost" onclick="stockModal(${m.id},'out')">Stock Out</button> <button class="btn sm ghost" aria-label="Edit material" onclick="editMaterial(${m.id})"><i class="bi bi-pencil"></i></button> <button class="btn sm danger" aria-label="Delete ${esc(m.name)}" onclick="deleteMaterialModal(${m.id})"><i class="bi bi-trash"></i></button></td></tr>`,
    )
    .join("");
  $("#inventory-log-empty").classList.toggle("hidden", I.log.length > 0);
  $("#inventory-log-table").classList.toggle("hidden", I.log.length === 0);
  $("#inventory-log-rows").innerHTML = I.log
    .map(
      (l) =>
        `<tr><td>${dt(l.ts)}</td><td>${esc(l.material)}</td><td>${esc(l.action)}</td><td>${l.net > 0 ? "+" : ""}${l.net}</td><td>${l.prev}</td><td>${l.res}</td><td>${esc(l.reason)}</td></tr>`,
    )
    .join("");
};
H({
  addMaterial: () =>
    modal(
      `<h2>Add New Inventory Material</h2><label>Material Name<input id="mn" placeholder="Enter material name"></label><label>Unit of Measurement<input id="mu" placeholder="e.g. grams, pcs, packs"></label><hr><div class="row"><label>Initial Stock In<input id="mq" type="number" min="0" step="any" placeholder="Quantity"></label><label>Low Stock Threshold<input id="mh" type="number" min="0" step="any" placeholder="Minimum stock"></label></div><label>Reason for Creation<input id="mr" placeholder="Enter reason..."></label><div class="btns"><button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn" onclick="saveMaterial()"><i class="bi bi-save"></i> Save</button></div>`,
    ),
  saveMaterial: async () => {
    const n = val("mn");
    await api("/api/materials", "POST", {
      name: n,
      unit: val("mu"),
      qty: num("mq"),
      threshold: num("mh"),
      reason: val("mr"),
    });
    closeModal();
    await renderView();
    toast(`"${n}" is added successfully`);
  },
  editMaterial: (id) => {
    const m = I.mats.find((x) => x.id === id);
    modal(
      `<h2>Edit Material</h2><label>Name<input id="mn" value="${esc(m.name)}"></label><label>Unit<input id="mu" value="${esc(m.unit)}"></label><label>Low Stock Threshold<input id="mh" type="number" min="0" step="any" value="${m.threshold}"></label><div class="btns"><button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn" onclick="updMaterial(${id})">Save</button></div>`,
    );
  },
  updMaterial: async (id) => {
    await api("/api/materials/" + id, "PUT", {
      name: val("mn"),
      unit: val("mu"),
      threshold: num("mh"),
    });
    closeModal();
    await renderView();
    toast("Material updated");
  },
  deleteMaterialModal: (id) => {
    const m = I.mats.find((x) => x.id === id);
    if (!m) throw new Error("Material not found");
    modal(
      `<h2>Delete ${esc(m.name)}?</h2><p>This material will be removed from active inventory and retained for existing products, orders, and audit history.</p><label>Reason for deletion<input id="delete-reason" placeholder="Why are you deleting this material?" required></label><div class="btns"><button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn danger" onclick="confirmDeleteMaterial(${id})"><i class="bi bi-trash"></i> Delete Material</button></div>`,
    );
  },
  confirmDeleteMaterial: async (id) => {
    const reason = val("delete-reason").trim();
    if (!reason) throw new Error("Enter a reason for deleting this material");
    await api("/api/materials/" + id, "DELETE", { reason });
    closeModal();
    await renderView();
    toast("Material deleted and recorded in the audit log");
  },
  stockModal: (id, type) => {
    const m = I.mats.find((x) => x.id === id);
    modal(
      `<h2>Stock ${type === "in" ? "In" : "Out"}: ${esc(m.name)}</h2><p>Remaining: <b>${m.remaining} ${esc(m.unit)}</b></p><label>Quantity (${esc(m.unit)})<input id="sq" type="number" min="0" step="any"></label><label>Reason<input id="sr" placeholder="${type === "in" ? "Restocking" : "Stock correction"}"></label><div class="btns"><button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn" onclick="doStock(${id},'${type}')">Save</button></div>`,
    );
  },
  doStock: async (id, type) => {
    await api(`/api/materials/${id}/stock`, "POST", {
      type,
      qty: num("sq"),
      reason: val("sr"),
    });
    closeModal();
    await renderView();
    toast("Inventory updated");
  },
});

/* ---------------- ORDERS ---------------- */
const isArch = (o) =>
  o.cancelled || (o.delivery === "Delivered" && o.payment === "Fully Paid");
const ocard = (
  o,
) => `<div class="ocard"><div class="between"><b>${o.code}</b><span class="muted">${o.customer.code}</span></div><div>${esc(o.customer.name)} · ${esc(o.customer.contact)}<br>${esc(o.customer.address)}</div><hr>${o.items.map((i) => `<div class="between"><span>${esc(i.name)}</span><span>${i.qty}x</span></div>`).join("")}<hr>
  <label>Production Status<select onchange="setStatus(${o.id},'production',this.value)">${sel(["Pending", "In Progress", "Completed"], o.production)}</select></label>
  <label>Delivery Status<select onchange="setStatus(${o.id},'delivery',this.value)">${sel(["Pending", "Shipped", "Delivered"], o.delivery)}</select></label>
  <div class="between"><span>Payment</span>${badge(o.payment)}</div><hr><div class="between"><b>${peso(o.total)}</b><button class="btn sm" onclick="orderEntry(${o.id})">View</button></div></div>`;
V.orders = async () => {
  const os = await api("/api/orders");
  O.all = os;
  O.current = os.filter((o) => !isArch(o));
  O.visible = os.filter((o) => O.arch || !isArch(o));
  return templateMarkup("orders-page-template");
};
AFTER.orders = () => {
  const empty = O.all.length === 0;
  $("#orders-empty").classList.toggle("hidden", !empty);
  $("#archive-toggle").checked = O.arch;
  $("#current-orders").innerHTML =
    O.current.map(ocard).join("") || '<p class="muted">No active orders.</p>';
  $("#orders-rows").innerHTML = O.visible
    .map(
      (o) =>
        `<tr><td>${o.code}</td><td>${d10(o.created)}</td><td>${esc(o.customer.name)}</td><td>${o.items.map((i) => esc(i.name) + " x" + i.qty).join(", ")}</td><td>${peso(o.total)}</td><td>${o.cancelled ? badge("Cancelled") : badge(o.production)}</td><td>${badge(o.delivery)}</td><td>${badge(o.payment)}</td><td><button class="btn sm" onclick="orderEntry(${o.id})">Open</button></td></tr>`,
    )
    .join("");
};
H({
  setStatus: async (id, k, v) => {
    try {
      await api(`/api/orders/${id}/status`, "PUT", { [k]: v });
      toast("Order updated");
    } finally {
      renderView();
    }
  },
  createOrder: async () => {
    O.prods = await api("/api/products");
    O.cart = {};
    if (!O.prods.length)
      throw new Error("Add a product in Product Costing & Pricing first");
    const cats = [...new Set(O.prods.map((p) => p.category).filter(Boolean))];
    modal(
      `<h2>Create Order</h2><div class="co"><div><div class="row"><input id="ps" placeholder="Search products" oninput="renderPicker()"><select id="pcat" onchange="renderPicker()"><option value="">All categories</option>${cats.map((c) => `<option>${esc(c)}</option>`).join("")}</select></div><div id="pick" class="grid"></div></div>
    <div><p class="muted">Order ID, Customer ID, date and Payment Slip ID are generated automatically.</p><label>Customer Name<input id="cn"></label><label>Contact No.<input id="cc"></label><label>Shipping Address<input id="ca"></label><div id="cart"></div>
    <p class="muted">Production, delivery and payment start as <b>Pending</b>.</p><div class="btns"><button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn" onclick="saveOrder()">Save Order</button></div></div></div>`,
      true,
    );
    renderPicker();
    renderCart();
  },
  addCart: (id) => {
    O.cart[id] = (O.cart[id] || 0) + 1;
    renderCart();
  },
  chgCart: (id, d) => {
    O.cart[id] = (O.cart[id] || 0) + d;
    if (O.cart[id] <= 0) delete O.cart[id];
    renderCart();
  },
  saveOrder: async () => {
    const o = await api("/api/orders", "POST", {
      customer: { name: val("cn"), contact: val("cc"), address: val("ca") },
      items: Object.entries(O.cart).map(([id, qty]) => ({
        product_id: +id,
        qty,
      })),
    });
    await renderView();
    done(
      "New order saved successfully!",
      `${o.code} · Payment Slip ${o.slipCode} · ${peso(o.total)}`,
    );
  },
  orderEntry: async (id) => {
    const o = await api("/api/orders/" + id);
    modal(`<h2 class="center">Order Entry</h2><div class="panel"><div class="between"><h3>${o.code}</h3><span class="muted">${dt(o.created)}</span></div><dl><dt>Order (Production) Status<dd>${o.cancelled ? badge("Cancelled") : badge(o.production)}<dt>Delivery Status<dd>${badge(o.delivery)}<dt>Payment Status<dd>${badge(o.payment)}<dt>Total Amount<dd>${peso(o.total)}</dl></div>
    <div class="panel"><h3>Customer Information</h3><dl><dt>Customer ID<dd>${o.customer.code}<dt>Customer Name<dd>${esc(o.customer.name)}<dt>Phone #<dd>${esc(o.customer.contact)}<dt>Shipping Address<dd>${esc(o.customer.address)}</dl></div>
    <div class="panel"><h3>Products Ordered</h3><table><thead><tr><th>Product<th>Qty<th>Unit Selling Price<th>Unit Cost<th></tr></thead><tbody>${o.items.map((i) => `<tr><td>${esc(i.name)}<td>${i.qty}<td>${peso(i.price)}<td>${peso(i.mat_cost + i.labor_cost + i.other_cost)}<td><button class="btn sm" onclick="viewBom(${o.id},${i.id})">View BOM</button>`).join("")}</tbody></table></div>
    <div class="panel"><h3>Payment Information</h3><dl><dt>Total Amount<dd>${peso(o.total)}<dt>Amount Paid<dd>${peso(o.paid)}<dt>Remaining Balance<dd>${peso(o.balance)}${o.cancelled ? `<dt>Refunded<dd>${peso(o.refund)}` : ""}</dl></div>
    <div class="btns"><button class="btn ghost" onclick="closeModal()">Close</button>${o.cancelled ? "" : `<button class="btn danger" onclick="cancelOrder(${o.id})">Cancel Order</button>`}</div>`);
  },
  viewBom: async (oid, iid) => {
    const [o, ms] = await Promise.all([
      api("/api/orders/" + oid),
      api("/api/materials"),
    ]);
    const it = o.items.find((i) => i.id === iid);
    O.bom = {
      oid,
      iid,
      ms,
      lines: it.bom.map((b) => ({
        material_id: b.material_id,
        qty: b.qty,
        unit_cost: b.unit_cost,
      })),
      locked: !!o.deducted || !!o.cancelled,
      name: it.name,
    };
    renderBomModal();
  },
  addBomLine: () => {
    const b = O.bom,
      mid = +val("om");
    if (b.lines.some((l) => l.material_id === mid))
      throw new Error("Material already in the BOM");
    b.lines.push({
      material_id: mid,
      qty: num("oq") || 1,
      unit_cost: num("ou"),
    });
    renderBomModal();
  },
  rmBomLine: (i) => {
    O.bom.lines.splice(i, 1);
    renderBomModal();
  },
  setBomLine: (i, k, v) => {
    O.bom.lines[i][k] = +v || 0;
  },
  saveBomLines: async () => {
    const b = O.bom;
    await api(`/api/orders/${b.oid}/items/${b.iid}/bom`, "PUT", {
      lines: b.lines,
    });
    await renderView();
    done(
      "BOM saved successfully!",
      "Unit and total product costs were recalculated.",
      `orderEntry(${b.oid})`,
    );
  },
  cancelOrder: (id) => {
    const o = O.all.find((x) => x.id === id);
    modal(
      `<h2>Cancel Order</h2><p>Are you sure you want to cancel ${o.code}? This action cannot be undone. Materials already deducted will be restored to inventory.</p><label>Refund amount (₱) - paid so far: ${peso(o.paid)}<input id="rf" type="number" min="0" step="any" value="0"></label><div class="btns"><button class="btn ghost" onclick="orderEntry(${id})">No</button><button class="btn danger" onclick="doCancel(${id})">Yes</button></div>`,
    );
  },
  doCancel: async (id) => {
    await api(`/api/orders/${id}/cancel`, "POST", { refund: num("rf") });
    await renderView();
    done("Order cancelled", "An order has been cancelled.");
  },
});
function renderPicker() {
  const q = val("ps").toLowerCase(),
    c = val("pcat");
  $("#pick").innerHTML =
    O.prods
      .filter(
        (p) => p.name.toLowerCase().includes(q) && (!c || p.category === c),
      )
      .map(
        (p) =>
          `<div class="pick" onclick="addCart(${p.id})"><div class="ph">${p.image ? `<img src="${p.image}">` : ""}</div><b>${esc(p.name)}</b><br>${peso(p.sellingPrice)}</div>`,
      )
      .join("") || '<p class="muted">No products found.</p>';
}
function renderCart() {
  let total = 0;
  const lines = Object.entries(O.cart)
    .map(([id, q]) => {
      const p = O.prods.find((x) => x.id == id);
      total += p.sellingPrice * q;
      return `<div class="cartline"><span>${esc(p.name)}<br><small>${peso(p.sellingPrice)}</small></span><span class="qty"><button aria-label="Decrease quantity" onclick="chgCart(${id},-1)"><i class="bi bi-dash"></i></button> ${q} <button aria-label="Increase quantity" onclick="chgCart(${id},1)"><i class="bi bi-plus"></i></button></span></div>`;
    })
    .join("");
  $("#cart").innerHTML =
    `<h3 style="margin-top:14px">Products</h3>${lines || '<p class="muted">Click a product to add it.</p>'}<div class="between" style="margin-top:10px"><b>Total</b><b>${peso(total)}</b></div>`;
}
function renderBomModal() {
  const b = O.bom;
  modal(`<h2>${esc(b.name)} - Bill of Materials</h2>${b.locked ? '<p class="alert">BOM is locked because production has started or the order is cancelled.</p>' : '<p class="muted">Customize materials for this order only (per 1 unit). Inventory is deducted when production is set to In Progress.</p>'}
  <table><thead><tr><th>Material<th>Quantity<th>Unit Price<th>Total Amount<th></tr></thead><tbody>${b.lines
    .map((l, i) => {
      const m = b.ms.find((x) => x.id == l.material_id) || {};
      return `<tr><td>${esc(m.name)}<td><input type="number" min="0" step="any" value="${l.qty}" ${b.locked ? "disabled" : ""} onchange="setBomLine(${i},'qty',this.value);renderBomModal()"><td><input type="number" min="0" step="any" value="${l.unit_cost}" ${b.locked ? "disabled" : ""} onchange="setBomLine(${i},'unit_cost',this.value);renderBomModal()"><td>${peso(l.qty * l.unit_cost)}<td>${b.locked ? "" : `<button class="btn sm ghost" aria-label="Remove material" onclick="rmBomLine(${i})"><i class="bi bi-x-lg"></i></button>`}`;
    })
    .join("")}</tbody></table>
  <p class="between"><b>Unit material cost</b><b>${peso(b.lines.reduce((s, l) => s + l.qty * l.unit_cost, 0))}</b></p>
  ${b.locked ? "" : `<div class="row"><select id="om">${b.ms.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join("")}</select><input id="oq" type="number" min="0" step="any" placeholder="Qty"><input id="ou" type="number" min="0" step="any" placeholder="Unit cost"><button class="btn" onclick="addBomLine()">Add Material</button></div>`}
  <div class="btns"><button class="btn ghost" onclick="orderEntry(${b.oid})">Close</button>${b.locked ? "" : '<button class="btn" onclick="saveBomLines()">Save BOM</button>'}</div>`);
}

/* ---------------- PAYMENTS ---------------- */
V.payments = async () => {
  I.payments = await api("/api/payments");
  return templateMarkup("payments-page-template");
};
AFTER.payments = () => {
  const empty = I.payments.length === 0;
  $("#payments-empty").classList.toggle("hidden", !empty);
  $("#payments-spacer").classList.toggle("hidden", empty);
  $("#payments-table-panel").classList.toggle("hidden", empty);
  $("#payments-rows").innerHTML = I.payments
    .map(
      (p) =>
        `<tr><td>${p.slipCode}</td><td>${p.orderCode}</td><td>${esc(p.customer)}</td><td>${peso(p.total)}</td><td>${peso(p.paid)}</td><td>${peso(p.balance)}</td><td>${dt(p.date)}</td><td>${p.cancelled ? badge("Cancelled") : badge(p.status)}</td><td><button class="btn sm" onclick="payslip(${p.slipId})">View Payment Slip</button></td></tr>`,
    )
    .join("");
};
H({
  payslip: async (sid) => {
    const s = await api("/api/payments/" + sid),
      open = !s.cancelled && s.balance > 0;
    modal(
      `<h2>Payment Slip ${s.slipCode}</h2><p class="muted">Order ${s.orderCode}</p><div class="co"><div class="panel"><h3>Log Payment</h3>${
        open
          ? `<label>Payment Method<select id="pm_">${sel(s.methods, s.methods[0])}</select></label>
      <label>Payment Option<select id="po" onchange="$('#pa').value=this.value==='Full Payment'?${s.balance}:${Math.min(s.suggestedDp, s.balance)}"><option value="">Select Payment Option</option><option>Downpayment</option><option>Full Payment</option></select></label>
      <label>Amount Paid (₱)<input id="pa" type="number" min="0" step="any" placeholder="Enter Amount"></label><label>Reference No. (required for GCash)<input id="pr" placeholder="Enter GCash Reference"></label><button class="btn" onclick="postPayment(${sid})">Post Payment</button>`
          : `<p class="muted">${s.cancelled ? "This order is cancelled." : "This order is fully paid."}</p>`
      }</div>
      <div class="panel"><dl><dt>Customer ID<dd>${s.customer.code}<dt>Customer Name<dd>${esc(s.customer.name)}<dt>Total Order Amount<dd>${peso(s.total)}<dt>Total Amount Paid<dd>${peso(s.paid)}<dt>Remaining Balance<dd>${peso(s.balance)}<dt>Status<dd>${badge(s.status)}</dl></div></div>
      <h3>Transactions</h3><table><thead><tr><th>Transaction ID<th>Payment Option<th>Method<th>Reference<th>Amount Paid<th>Date & Time</tr></thead><tbody>${s.transactions.map((t) => `<tr><td>${t.code}<td>${esc(t.type)}<td>${esc(t.method)}<td>${esc(t.ref)}<td>${peso(t.amount)}<td>${dt(t.ts)}`).join("") || '<tr><td colspan="6" class="muted">No payments yet.</td></tr>'}</tbody></table><div class="btns"><button class="btn ghost" onclick="closeModal()">Close</button></div>`,
      true,
    );
  },
  postPayment: async (sid) => {
    await api("/api/payments/" + sid, "POST", {
      method: val("pm_"),
      type: val("po"),
      amount: num("pa"),
      ref: val("pr"),
    });
    await renderView();
    done("Payment logged successfully!", "", `payslip(${sid})`);
  },
});

/* ---------------- REPORTS ---------------- */
V.reports = async () => {
  if (!R.to) {
    const t = new Date(),
      f = new Date(t.getFullYear(), t.getMonth() - 5, 1);
    R.from = d10(f);
    R.to = d10(t);
    R.group = "month";
  }
  const qs = `from=${R.from}&to=${R.to}&group=${R.group}`,
    r = await api("/api/reports?" + qs);
  R.data = r;
  return templateMarkup("reports-page-template");
};
AFTER.reports = () => {
  const r = R.data,
    k = r.kpi,
    c = r.customers,
    np = c.total ? Math.round((c.new / c.total) * 100) : 0,
    prodList = (list, key) =>
      list
        .map(
          (p, i) =>
            `<div class="between alert"><span>${String(i + 1).padStart(2, "0")} · ${esc(p.name)} <small>(${p.qty} sold)</small></span><b>${peso(p[key])}</b></div>`,
        )
        .join("") || '<p class="muted">No data.</p>';
  $("#rf").value = R.from;
  $("#rt").value = R.to;
  $("#rg").value = R.group;
  $("#report-sales").textContent = peso(k.sales);
  $("#report-material").textContent = peso(k.material);
  $("#report-material-pct").textContent = `${k.materialPct}% of sales`;
  $("#report-labor").textContent = peso(k.labor);
  $("#report-labor-pct").textContent = `${k.laborPct}% of sales`;
  $("#report-profit").textContent = peso(k.profit);
  $("#report-margin").textContent = `${k.margin}% gross margin`;
  $("#report-sales-chart").innerHTML = bars(
    r.series.map((s) => [s.period, s.sales]),
  );
  $("#report-profit-chart").innerHTML = bars(
    r.series.map((s) => [s.period, Math.max(0, s.profit)]),
  );
  $("#report-expense-chart").innerHTML = bars(
    r.series.map((s) => [s.period, s.material + s.labor]),
  );
  $("#report-top-sales").innerHTML = prodList(r.topBySales, "sales");
  $("#report-top-profit").innerHTML = prodList(r.topByProfit, "profit");
  $("#report-customer-donut").style.background =
    `conic-gradient(#bf6685 0 ${np}%,#f7c0d0 ${np}% 100%)`;
  $("#report-customer-total").textContent = c.total;
  $("#report-customer-counts").textContent =
    `New ${c.new} · Returning ${c.returning}`;
  $("#report-top-customers").innerHTML = r.topCustomers
    .map(
      (x) =>
        `<div class="between alert"><span>${esc(x.name)} <small>(${x.orders} orders)</small></span><b>${peso(x.revenue)}</b></div>`,
    )
    .join("");
  $("#report-pending").textContent = `${r.payments.Pending} orders`;
  $("#report-downpayment").textContent = `${r.payments.Downpayment} orders`;
  $("#report-paid").textContent = `${r.payments["Fully Paid"]} orders`;
  $("#report-cash-in").textContent = peso(r.cash.cashIn);
  $("#report-refunds").textContent = peso(r.cash.refunds);
  $("#report-net-cash").textContent = peso(r.cash.net);
  $("#report-outstanding").textContent = peso(r.cash.outstanding);
};
H({
  exportCsv: async () => {
    const r = await api(
        `/api/reports?from=${R.from}&to=${R.to}&group=${R.group}`,
      ),
      q = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const rows = [
      ["Period", "Sales", "Material Expense", "Labor Expense", "Gross Profit"],
      ...r.series.map((s) => [
        s.period,
        s.sales,
        s.material,
        s.labor,
        s.profit,
      ]),
      [],
      ["Total", r.kpi.sales, r.kpi.material, r.kpi.labor, r.kpi.profit],
    ];
    const a = document.createElement("a");
    a.href = URL.createObjectURL(
      new Blob([rows.map((x) => x.map(q).join(",")).join("\n")], {
        type: "text/csv",
      }),
    );
    a.download = "sakura-financial-report.csv";
    a.click();
  },
  resetData: () => {
    if (
      confirm(
        "Erase ALL data stored in this browser (products, orders, payments, accounts)?",
      )
    ) {
      localStorage.setItem(KEY, JSON.stringify(fresh()));
      location.reload();
    }
  },
  applyReport: () => {
    R.from = val("rf");
    R.to = val("rt");
    R.group = val("rg");
    renderView();
  },
});

/* ---------------- SETTINGS ---------------- */
V.settings = async () => {
  const s = await api("/api/settings");
  I.methods = s.methods;
  I.settings = s;
  return templateMarkup("settings-page-template");
};
AFTER.settings = () => {
  $("#dp").value = I.settings.dp_percent;
  $("#payment-methods").innerHTML = I.methods
    .map(
      (m) =>
        `<div class="between alert">${esc(m)}${m !== "GCash" ? `<button class="btn sm ghost" aria-label="Remove ${esc(m)}" onclick="rmMethod('${esc(m)}')"><i class="bi bi-x-lg"></i></button>` : " <small>default</small>"}</div>`,
    )
    .join("");
};
H({
  saveSettings: async () => {
    await api("/api/settings", "PUT", { dp_percent: num("dp") });
    toast("Settings saved");
  },
  addMethod: async () => {
    if (!val("nm").trim()) throw new Error("Enter a method name");
    await api("/api/settings", "PUT", { methods: [...I.methods, val("nm")] });
    renderView();
  },
  rmMethod: async (m) => {
    await api("/api/settings", "PUT", {
      methods: I.methods.filter((x) => x !== m),
    });
    renderView();
  },
});

api("/api/me")
  .then((u) => (user = u))
  .catch(() => {})
  .finally(route);
