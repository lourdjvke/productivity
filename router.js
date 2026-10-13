const DEFAULT_DATA_URL = new URL("./data.json", import.meta.url);
const ROUTE_ATTRIBUTE = "leo-pid";
const EXECUTABLE_SCRIPT_TYPES = new Set([
  "",
  "module",
  "text/javascript",
  "application/javascript",
  "text/ecmascript",
  "application/ecmascript",
]);

export function normalizePath(value) {
  const path = String(value || "/")
    .trim()
    .split(/[?#]/, 1)[0]
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/");
  const absolute = path.startsWith("/") ? path : `/${path}`;
  return absolute.replace(/\/+$/, "") || "/";
}

export function normalizeBasePath(value = "/") {
  const path = normalizePath(value);
  return path === "/" ? "/" : `${path}/`;
}

export function stripBasePath(pathname, basePath = "/") {
  const path = normalizePath(pathname);
  const base = normalizeBasePath(basePath);
  if (base === "/") return path;

  const baseWithoutSlash = base.slice(0, -1);
  if (path === baseWithoutSlash) return "/";
  if (path.startsWith(base)) return normalizePath(path.slice(base.length - 1));
  return path;
}

function routeEntry(routes, key) {
  const entry = routes[key];
  if (typeof entry === "string") return { file: entry };
  return entry && typeof entry === "object" && !Array.isArray(entry)
    ? entry
    : null;
}

function compileRoutePattern(pattern) {
  const names = [];
  let staticSegments = 0;
  const segments = normalizePath(pattern).split("/").filter(Boolean);
  const source = segments
    .map((segment) => {
      if (segment.startsWith(":")) {
        const name = segment.slice(1);
        if (!/^[A-Za-z_][\w]*$/.test(name) || names.includes(name)) return null;
        names.push(name);
        return "([^/]+)";
      }
      staticSegments += 1;
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    });

  if (source.some((segment) => segment === null)) return null;
  return {
    names,
    staticSegments,
    segmentCount: segments.length,
    specificity: segments.map((segment) => (segment.startsWith(":") ? "0" : "1")).join(""),
    expression: new RegExp(`^/${source.join("/")}$`),
  };
}

export function resolveRoute(config, pathname) {
  const path = normalizePath(stripBasePath(pathname, config.basePath));
  const routes = config.routes || {};
  const direct = routeEntry(routes, path);

  if (direct) {
    return { key: path, route: direct, requestedPath: path, params: {}, found: true };
  }

  const patterns = Object.keys(routes)
    .map((key, order) => {
      const pattern = compileRoutePattern(key);
      return pattern
        ? { key, route: routeEntry(routes, key), pattern, order }
        : null;
    })
    .filter((entry) => entry?.route)
    .sort(
      (a, b) =>
        b.pattern.staticSegments - a.pattern.staticSegments ||
        b.pattern.specificity.localeCompare(a.pattern.specificity) ||
        b.pattern.segmentCount - a.pattern.segmentCount ||
        a.order - b.order,
    );

  for (const entry of patterns) {
    const match = path.match(entry.pattern.expression);
    if (!match) continue;

    const params = Object.create(null);
    entry.pattern.names.forEach((name, index) => {
      params[name] = decodeURIComponent(match[index + 1]);
    });
    return {
      key: entry.key,
      route: entry.route,
      requestedPath: path,
      params,
      found: true,
    };
  }

  if (path === "/") {
    const defaultPath = normalizePath(config.defaultRoute || "/");
    const defaultEntry = routeEntry(routes, defaultPath);
    if (defaultEntry) {
      return {
        key: defaultPath,
        route: defaultEntry,
        requestedPath: path,
        params: {},
        found: true,
      };
    }
  }

  const notFoundKey = config.notFound
    ? normalizePath(config.notFound)
    : null;
  const notFound = notFoundKey ? routeEntry(routes, notFoundKey) : null;
  return {
    key: notFound ? notFoundKey : path,
    route: notFound,
    requestedPath: path,
    params: {},
    found: false,
  };
}

function asUrl(value, currentUrl) {
  return value instanceof URL ? new URL(value.href) : new URL(String(value || "/"), currentUrl);
}

function routeFile(route) {
  if (typeof route === "string") return route;
  return route?.file || route?.page || route?.html || null;
}

function routeRedirect(route) {
  const redirect = route?.redirect ?? route?.redirectTo;
  if (typeof redirect === "string") return { to: redirect };
  if (redirect && typeof redirect === "object" && typeof redirect.to === "string") {
    return redirect;
  }
  return null;
}

function isExecutableScript(type = "") {
  return EXECUTABLE_SCRIPT_TYPES.has(type.trim().toLowerCase());
}

function isSpecialUrl(value) {
  return (
    value.startsWith("#") ||
    value.startsWith("//") ||
    /^[a-z][a-z\d+.-]*:/i.test(value)
  );
}

export class LeoRouter {
  constructor(options = {}) {
    this.dataUrl = new URL(options.dataUrl || DEFAULT_DATA_URL);
    this.rootSelector = options.root;
    this.loaderSelector = options.loaderRoot;
    this.config = null;
    this.root = null;
    this.loaderRoot = null;
    this.loaderMarkup = "";
    this.navigationId = 0;
    this.controller = null;
    this.componentCache = new Map();
    this.componentModules = new Map();
    this.componentInstances = new Map();
    this.componentRoots = new Set();
    this.componentObserver = null;
    this.started = false;
    this.activeUrl = null;
    this.activeRoute = null;
    this.routeData = null;
    this.currentContext = null;
    this.isTransitioning = false;
    this.persistentStash = new Map();
    this.persistentPool = null;
    this.handleClick = this.handleClick.bind(this);
    this.handlePopState = this.handlePopState.bind(this);
  }

  async start() {
    if (this.started) return this;

    // Ensure hidden persistent pool exists to keep off-route persistent elements alive and streaming
    let pool = document.querySelector("#leoPersistentPool");
    if (!pool) {
      pool = document.createElement("div");
      pool.id = "leoPersistentPool";
      pool.hidden = true;
      pool.setAttribute("aria-hidden", "true");
      pool.style.display = "none";
      document.body.append(pool);
    }
    this.persistentPool = pool;

    const configResponse = await fetch(this.dataUrl, { cache: "no-cache" });
    if (!configResponse.ok) {
      throw new Error(`Could not load ${this.dataUrl.pathname} (${configResponse.status}).`);
    }

    const config = await configResponse.json();
    this.validateConfig(config);
    this.config = config;
    this.config.basePath = normalizeBasePath(config.basePath || "/");
    this.root = document.querySelector(this.rootSelector || config.root || "#pidRoot");

    if (!this.root) {
      throw new Error(
        `LEO could not find its page mount (${this.rootSelector || config.root || "#pidRoot"}). Add that element to index.html.`,
      );
    }

    this.loaderRoot = document.querySelector(
      this.loaderSelector || config.loaderRoot || "#pidLoader",
    );
    if (!this.loaderRoot) {
      this.loaderRoot = document.createElement("div");
      this.loaderRoot.id = "pidLoader";
      this.loaderRoot.hidden = true;
      document.body.append(this.loaderRoot);
    }

    this.root.setAttribute("aria-busy", "true");
    if (config.loader !== false) {
      const loaderUrl = new URL(config.loader || "pig-loader.html", this.dataUrl);
      this.loaderMarkup = await this.readText(loaderUrl);
    }

    this.componentObserver = new MutationObserver(() =>
      this.cleanupDetachedComponents(),
    );
    await this.expandShellIncludes();
    this.refreshComponentObserver();
    this.hydrateLinks(document);
    this.started = true;
    document.addEventListener("click", this.handleClick);
    window.addEventListener("popstate", this.handlePopState);

    const initialUrl = this.makeUrl(window.location.href, new URL(window.location.href));
    await this.transition(initialUrl, { history: "none", scroll: false });
    return this;
  }

  validateConfig(config) {
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new Error("LEO data.json must contain a JSON object.");
    }
    if (!config.routes || typeof config.routes !== "object" || Array.isArray(config.routes)) {
      throw new Error('LEO data.json needs a "routes" object.');
    }
    const mode = config.mode || (config.spa === false ? "multi-page" : "spa");
    if (!["spa", "multi-page", "document"].includes(mode)) {
      throw new Error('LEO mode must be "spa" or "multi-page".');
    }
    config.mode = mode;
  }

  makeUrl(destination, currentUrl) {
    const url = asUrl(destination, currentUrl);
    if (url.origin !== window.location.origin || !this.config) return url;

    const base = normalizeBasePath(this.config.basePath || "/");
    const path = normalizePath(url.pathname);
    if (base !== "/" && path !== base.slice(0, -1) && !path.startsWith(base)) {
      url.pathname = path === "/" ? base : `${base}${path.slice(1)}`;
    }
    return url;
  }

  routePath(url) {
    return stripBasePath(url.pathname, this.config.basePath);
  }

  async readText(url, signal) {
    const response = await fetch(url, { cache: "no-cache", signal });
    if (!response.ok) {
      throw new Error(`Could not load ${url.pathname} (${response.status}).`);
    }
    return response.text();
  }

  resolveComponentUrl(source) {
    const value = source.trim();
    if (!value) throw new Error("A <leo-include> needs a non-empty src.");

    const siteRoot = new URL("./", this.dataUrl);
    const url = new URL(value.replace(/^\/+/, ""), siteRoot);
    if (url.origin !== window.location.origin) {
      throw new Error(`LEO components must be served from this site: ${url.href}`);
    }
    return url;
  }

  resolveComponentResource(source, componentUrl) {
    const value = source.trim();
    if (isSpecialUrl(value)) return new URL(value, componentUrl);
    if (value.startsWith("/")) {
      return new URL(value.replace(/^\/+/, ""), new URL("./", this.dataUrl));
    }
    return new URL(value, componentUrl);
  }

  ensureIncludeHostStyle() {
    if (document.head.querySelector("[data-leo-include-base-style]")) return;

    const style = document.createElement("style");
    style.dataset.leoIncludeBaseStyle = "true";
    style.textContent = "leo-include[data-leo-loaded] { display: contents; }";
    document.head.append(style);
  }

  async expandShellIncludes() {
    const includes = Array.from(document.querySelectorAll("leo-include")).filter(
      (include) =>
        !this.root.contains(include) &&
        !include.parentElement?.closest("leo-include"),
    );

    for (const include of includes) {
      await this.expandComponent(include, new Set(), 0, undefined, "shell");
    }
  }

  async expandIncludes(container, stack, depth, signal, scope, transitionId) {
    const includes = Array.from(container.querySelectorAll("leo-include")).filter(
      (include) => {
        if (include.dataset.leoLoaded === "true" || include.dataset.leoPreserved || include.dataset.leoPreservedTarget) return false;
        const parentInclude = include.parentElement?.closest("leo-include");
        return !parentInclude || parentInclude === container;
      },
    );

    for (const include of includes) {
      if (signal?.aborted) return;
      await this.expandComponent(
        include,
        stack,
        depth,
        signal,
        scope,
        transitionId,
      );
    }
  }

  async expandComponent(
    include,
    stack,
    depth,
    signal,
    scope = "page",
    transitionId = this.navigationId,
  ) {
    if (include.dataset.leoLoaded === "true" || include.dataset.leoPreserved) return;
    if (depth >= 20) {
      throw new Error("LEO stopped a component chain after 20 nested includes.");
    }

    const componentUrl = this.resolveComponentUrl(include.getAttribute("src") || "");
    if (stack.has(componentUrl.href)) {
      throw new Error(`LEO found a component include loop at "${componentUrl.pathname}".`);
    }
    if (signal?.aborted) return;

    let markup = this.componentCache.get(componentUrl.href);
    if (markup === undefined) {
      markup = await this.readText(componentUrl, signal);
      if (!signal?.aborted) this.componentCache.set(componentUrl.href, markup);
    }
    if (signal?.aborted) return;

    const parsed = new DOMParser().parseFromString(markup, "text/html");
    const componentRoot = parsed.querySelector("#pidRoot") || parsed.body;
    const styles = [];
    for (const link of parsed.querySelectorAll('link[rel~="stylesheet"][href]')) {
      const href = link.getAttribute("href");
      if (href) {
        styles.push({
          kind: "link",
          href: this.resolveComponentResource(href, componentUrl).href,
          attributes: Array.from(link.attributes).filter(
            (attribute) => attribute.name !== "href" && attribute.name !== "rel",
          ),
        });
      }
      link.remove();
    }
    for (const style of parsed.querySelectorAll("style")) {
      styles.push({ kind: "style", text: style.textContent || "" });
      style.remove();
    }

    let moduleUrl = null;
    const scripts = Array.from(parsed.querySelectorAll("script"));
    if (scripts.length > 1) {
      throw new Error(
        `LEO component "${componentUrl.pathname}" can declare only one module script.`,
      );
    }
    if (scripts.length === 1) {
      const script = scripts[0];
      const source = script.getAttribute("src");
      if (script.getAttribute("type")?.trim().toLowerCase() !== "module" || !source) {
        throw new Error(
          `LEO component "${componentUrl.pathname}" scripts must be external type="module" files.`,
        );
      }
      moduleUrl = this.resolveComponentResource(source, componentUrl);
      if (moduleUrl.origin !== window.location.origin) {
        throw new Error("LEO component modules must be served from this site.");
      }
      script.remove();
    }

    const nextStack = new Set(stack);
    nextStack.add(componentUrl.href);
    await this.expandIncludes(
      include,
      nextStack,
      depth + 1,
      signal,
      scope,
      transitionId,
    );
    await this.expandIncludes(
      componentRoot,
      nextStack,
      depth + 1,
      signal,
      scope,
      transitionId,
    );
    if (signal?.aborted) return;

    const nodes = Array.from(componentRoot.childNodes);
    this.absolutizeNodes(nodes, componentUrl);
    this.ensureIncludeHostStyle();
    include.dataset.leoLoaded = "true";
    include.dataset.leoComponent = componentUrl.href;
    const shadow = include.attachShadow({ mode: "open" });
    this.componentRoots.add(shadow);
    this.refreshComponentObserver();
    const baseStyle = document.createElement("style");
    baseStyle.textContent = "leo-include[data-leo-loaded] { display: contents; }";
    shadow.append(baseStyle);
    for (const style of styles) {
      if (style.kind === "link") {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = style.href;
        for (const attribute of style.attributes) {
          link.setAttribute(attribute.name, attribute.value);
        }
        shadow.append(link);
      } else {
        const element = document.createElement("style");
        element.textContent = style.text;
        shadow.append(element);
      }
    }
    shadow.append(...nodes);

    if (moduleUrl) {
      this.componentInstances.set(include, {
        host: include,
        moduleUrl,
        scope,
        transitionId,
        abortController: new AbortController(),
        instance: null,
        observer: null,
        mounted: false,
        mounting: null,
        disposed: false,
      });
    }
  }

  absolutizeNodes(nodes, baseUrl) {
    for (const node of nodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const elements = [node, ...node.querySelectorAll("[src], [href], [poster], [action]")];

      for (const element of elements) {
        for (const attribute of ["src", "href", "poster", "action"]) {
          if (!element.hasAttribute(attribute)) continue;
          if (attribute === "href" && element.hasAttribute(ROUTE_ATTRIBUTE)) continue;
          if (attribute === "src" && element.localName === "leo-include") continue;

          const value = element.getAttribute(attribute).trim();
          if (!value || isSpecialUrl(value)) continue;
          element.setAttribute(
            attribute,
            this.resolveComponentResource(value, baseUrl).href,
          );
        }
      }
    }
  }

  elementsInTree(scope, selector) {
    const found = [];
    const seenElements = new Set();
    const pendingRoots = [scope];
    const seenRoots = new Set();

    while (pendingRoots.length) {
      const root = pendingRoots.pop();
      if (!root || seenRoots.has(root)) continue;
      seenRoots.add(root);

      if (root instanceof Element && root.matches(selector)) {
        found.push(root);
        seenElements.add(root);
      }

      for (const element of root.querySelectorAll("*")) {
        if (element.matches(selector) && !seenElements.has(element)) {
          found.push(element);
          seenElements.add(element);
        }
        if (element.shadowRoot) pendingRoots.push(element.shadowRoot);
      }
    }
    return found;
  }

  componentProps(host) {
    const props = Object.create(null);
    for (const attribute of host.attributes) {
      const name = attribute.name.toLowerCase();
      if (
        ["src", "class", "style", "slot"].includes(name) ||
        name.startsWith("data-leo-")
      ) {
        continue;
      }
      const property = name.replace(/-([a-z])/g, (_, character) =>
        character.toUpperCase(),
      );
      props[property] = attribute.value === "" ? true : attribute.value;
    }
    return props;
  }

  componentContext(state) {
    const current = this.currentContext || {};
    return {
      host: state.host,
      root: state.host.shadowRoot,
      props: this.componentProps(state.host),
      signal: state.abortController.signal,
      moduleUrl: state.moduleUrl.href,
      route: current.route || null,
      path: current.path || null,
      params: current.params || {},
      query: current.query || {},
      data: current.data ?? null,
      url: current.url || null,
    };
  }

  async importComponentModule(moduleUrl) {
    const key = moduleUrl.href;
    let pending = this.componentModules.get(key);
    if (!pending) {
      pending = import(key);
      this.componentModules.set(key, pending);
      pending.catch(() => {
        if (this.componentModules.get(key) === pending) {
          this.componentModules.delete(key);
        }
      });
    }
    return pending;
  }

  async mountComponent(state) {
    if (state.disposed || state.mounted || !state.host.isConnected) return;
    if (state.mounting) return state.mounting;

    state.mounting = (async () => {
      const module = await this.importComponentModule(state.moduleUrl);
      if (state.disposed || !state.host.isConnected) return;

      const mount =
        module.mount ||
        module.default?.mount ||
        (typeof module.default === "function" ? module.default : null);
      if (typeof mount !== "function") {
        throw new Error(
          `LEO component module "${state.moduleUrl.pathname}" must export mount(context).`,
        );
      }

      const instance = await mount(this.componentContext(state));
      if (state.disposed || !state.host.isConnected) {
        if (typeof instance === "function") await instance();
        else if (typeof instance?.unmount === "function") await instance.unmount();
        return;
      }

      state.instance = instance;
      state.mounted = true;
      state.observer = new MutationObserver(() => {
        if (state.disposed || typeof state.instance?.update !== "function") return;
        Promise.resolve(state.instance.update(this.componentContext(state))).catch(
          (error) => console.error("[LEO] Component update failed:", error),
        );
      });
      state.observer.observe(state.host, { attributes: true });
    })();

    try {
      await state.mounting;
    } catch (error) {
      await this.disposeComponent(state);
      throw error;
    } finally {
      state.mounting = null;
    }
  }

  async mountComponents(transitionId) {
    const pending = Array.from(this.componentInstances.values()).filter(
      (state) =>
        !state.disposed &&
        !state.mounted &&
        state.host.isConnected &&
        (state.scope === "shell" || state.transitionId === transitionId),
    );
    for (const state of pending) await this.mountComponent(state);
  }

  async updateShellComponents() {
    for (const state of this.componentInstances.values()) {
      if (
        state.scope !== "shell" ||
        !state.mounted ||
        typeof state.instance?.update !== "function"
      ) {
        continue;
      }
      await state.instance.update(this.componentContext(state));
    }
  }

  async updatePersistentComponents(preservedElements) {
    if (!preservedElements || !preservedElements.size) return;
    for (const host of preservedElements) {
      const state = this.componentInstances.get(host);
      if (state && state.mounted && typeof state.instance?.update === "function") {
        try {
          await state.instance.update(this.componentContext(state));
        } catch (error) {
          console.error("[LEO] Persistent component update failed:", error);
        }
      }
    }
  }

  async disposeComponent(state) {
    if (!state || state.disposed) return;
    state.disposed = true;
    state.observer?.disconnect();
    state.abortController.abort();
    this.componentInstances.delete(state.host);
    if (state.host.shadowRoot) this.componentRoots.delete(state.host.shadowRoot);
    this.refreshComponentObserver();

    const instance = state.instance;
    state.instance = null;
    state.mounted = false;
    try {
      if (typeof instance === "function") await instance();
      else if (typeof instance?.unmount === "function") await instance.unmount();
    } catch (error) {
      console.error("[LEO] Component cleanup failed:", error);
    }
  }

  async disposeComponents(predicate) {
    const states = Array.from(this.componentInstances.values()).filter(predicate);
    for (const state of states) await this.disposeComponent(state);
  }

  refreshComponentObserver() {
    if (!this.componentObserver || !document.body) return;
    this.componentObserver.disconnect();
    this.componentObserver.observe(document.body, { childList: true, subtree: true });
    for (const root of this.componentRoots) {
      if (root.host.isConnected) {
        this.componentObserver.observe(root, { childList: true, subtree: true });
      }
    }
  }

  isPersistentHost(host) {
    if (!host) return false;
    const key = host.getAttribute?.("persist") || host.getAttribute?.("data-leo-persist");
    return Boolean(key && (this.persistentStash.has(key) || this.root?.contains(host)));
  }

  cleanupDetachedComponents() {
    if (this.isTransitioning) return;
    const disconnectedRoots = Array.from(this.componentRoots).filter(
      (root) => !root.host.isConnected,
    );
    for (const root of disconnectedRoots) this.componentRoots.delete(root);
    this.refreshComponentObserver();
    void this.disposeComponents(
      (state) => !state.host.isConnected && !this.isPersistentHost(state.host)
    );
  }

  async loadRouteData(route, params, signal) {
    if (route.data === undefined || route.data === null) return null;
    if (typeof route.data !== "string" || !route.data.trim()) {
      throw new Error('A route "data" value must be a non-empty JSON file path.');
    }

    const path = route.data.replace(/:([A-Za-z_][\w]*)/g, (_, name) => {
      if (!Object.hasOwn(params, name)) {
        throw new Error(`Route data path needs the missing parameter ":${name}".`);
      }
      const value = params[name];
      if (/[\\/]/.test(value) || value === "." || value === "..") {
        throw new Error(`Route data parameter ":${name}" must be one safe path segment.`);
      }
      return encodeURIComponent(value);
    });
    const url = new URL(path, this.dataUrl);
    if (url.origin !== window.location.origin) {
      throw new Error("LEO route data must be served from this site.");
    }

    const response = await fetch(url, { cache: "no-cache", signal });
    if (!response.ok) {
      throw new Error(`Could not load route data ${url.pathname} (${response.status}).`);
    }
    return response.json();
  }

  applyDataBindings(root, context) {
    for (const element of this.elementsInTree(root, "[data-leo-text]")) {
      const path = element.getAttribute("data-leo-text").trim();
      const parts = path.split(".").filter(Boolean);
      let value = context;
      for (const part of parts) {
        if (["__proto__", "prototype", "constructor"].includes(part)) {
          value = undefined;
          break;
        }
        value =
          value !== null &&
          typeof value === "object" &&
          Object.hasOwn(value, part)
            ? value[part]
            : undefined;
      }
      element.textContent =
        value == null
          ? ""
          : typeof value === "object"
            ? JSON.stringify(value)
            : String(value);
    }
  }

  routeContext(target, data) {
    return {
      path: target.resolved.requestedPath,
      key: target.resolved.key,
      found: target.resolved.found,
      route: target.resolved.route,
      params: target.resolved.params || {},
      query: Object.fromEntries(target.url.searchParams.entries()),
      data,
      url: target.url,
    };
  }

  resolveRedirects(startUrl) {
    let url = new URL(startUrl.href);
    let replace = false;
    const visited = new Set();

    for (let depth = 0; depth < 16; depth += 1) {
      if (url.origin !== window.location.origin) {
        return { externalUrl: url, replace };
      }

      const path = this.routePath(url);
      const resolved = resolveRoute(this.config, path);
      const redirect = routeRedirect(resolved.route);
      if (!redirect) return { url, resolved, replace };

      if (visited.has(path)) {
        throw new Error(`LEO found a redirect loop at "${path}".`);
      }
      visited.add(path);

      const target = this.makeUrl(redirect.to, url);
      if (target.origin !== url.origin) {
        return { externalUrl: target, replace: replace || redirect.replace === true };
      }
      if (!target.search && url.search && redirect.preserveQuery !== false) {
        target.search = url.search;
      }
      if (!target.hash && url.hash && redirect.preserveHash !== false) {
        target.hash = url.hash;
      }

      replace = replace || redirect.replace === true;
      url = target;
    }

    throw new Error("LEO stopped a redirect chain after 16 routes.");
  }

  async transition(destination, options = {}) {
    const id = ++this.navigationId;
    this.controller?.abort();
    this.controller = new AbortController();
    const { signal } = this.controller;
    this.isTransitioning = true;

    try {
      // 1. Gather all persistent elements from live root AND persistentStash / persistentPool
      const availablePersistent = new Map(this.persistentStash);
      if (this.root) {
        const found = this.root.querySelectorAll("[data-leo-persist], leo-include[persist]");
        for (const el of found) {
          const key = el.getAttribute("persist") || el.getAttribute("data-leo-persist");
          if (key) {
            availablePersistent.set(key, el);
            this.persistentStash.set(key, el);
          }
        }
      }

      await this.disposeComponents(
        (state) => state.scope === "page" && !state.mounted && !this.isPersistentHost(state.host),
      );
      const startUrl = this.makeUrl(destination, new URL(window.location.href));
      const target = this.resolveRedirects(startUrl);
      if (target.externalUrl) {
        window.location.assign(target.externalUrl.href);
        return;
      }
      if (!target.resolved?.route) {
        throw new Error(`No route is configured for "${target.resolved?.requestedPath || startUrl.pathname}".`);
      }

      this.showLoader();
      this.root.setAttribute("aria-busy", "true");

      const route = target.resolved.route;
      const file = routeFile(route);
      if (!file) {
        throw new Error(`Route "${target.resolved.key}" needs a "file" or "redirect" value.`);
      }

      const pageUrl = new URL(file, this.dataUrl);
      const [markup, routeData] = await Promise.all([
        this.readText(pageUrl, signal),
        this.loadRouteData(route, target.resolved.params || {}, signal),
      ]);
      if (signal.aborted || id !== this.navigationId) return;

      const parsed = new DOMParser().parseFromString(markup, "text/html");
      const sourceRoot = parsed.querySelector("#pidRoot") || parsed.body;

      // 2. Identify incoming persistent placeholders
      const incomingPersistent = Array.from(
        sourceRoot.querySelectorAll("[data-leo-persist], leo-include[persist]")
      );
      const incomingKeys = new Set();
      const preservedElements = new Set();
      const preservedSwaps = [];

      for (const placeholder of incomingPersistent) {
        const key = placeholder.getAttribute("persist") || placeholder.getAttribute("data-leo-persist");
        if (!key) continue;
        incomingKeys.add(key);

        if (availablePersistent.has(key)) {
          const existing = availablePersistent.get(key);
          preservedElements.add(existing);
          // Mark placeholder so expandIncludes skips it and we swap right at DOM commit
          placeholder.dataset.leoPreservedTarget = key;
          preservedSwaps.push({ placeholder, existing, key });
        }
      }

      await this.expandIncludes(
        sourceRoot,
        new Set([pageUrl.href]),
        0,
        signal,
        "page",
        id,
      );
      if (signal.aborted || id !== this.navigationId) return;

      const routeContext = this.routeContext(target, routeData);
      this.applyDataBindings(sourceRoot, routeContext);
      const scripts = this.collectScripts(parsed, route);
      const pageNodes = this.collectPageNodes(parsed, pageUrl);
      await this.replacePageStyles(parsed, route, pageUrl, id);
      if (signal.aborted || id !== this.navigationId) return;

      if (options.history === "push") {
        const useReplace = options.replace || target.replace;
        window.history[useReplace ? "replaceState" : "pushState"](
          { leo: true },
          "",
          target.url.href,
        );
      } else if (options.history === "replace") {
        window.history.replaceState({ leo: true }, "", target.url.href);
      } else if (
        options.history === "none" &&
        target.replace &&
        target.url.href !== window.location.href
      ) {
        window.history.replaceState({ leo: true }, "", target.url.href);
      }

      // Stash any active persistent elements in this.root that are NOT in the incoming view into persistentPool
      if (this.root && this.persistentPool) {
        for (const [key, el] of availablePersistent.entries()) {
          if (!incomingKeys.has(key) && el.isConnected && this.root.contains(el)) {
            this.persistentPool.append(el);
          }
        }
      }

      // Dispose components that are non-persistent page components
      await this.disposeComponents(
        (state) =>
          state.scope === "page" &&
          !preservedElements.has(state.host) &&
          !this.isPersistentHost(state.host) &&
          (state.mounted || state.transitionId !== id),
      );
      if (signal.aborted || id !== this.navigationId) return;

      // 3. Atomically swap preserved live elements directly into target placeholders in pageNodes
      for (const { placeholder, existing } of preservedSwaps) {
        for (const attr of Array.from(placeholder.attributes)) {
          if (!attr.name.startsWith("data-leo-")) {
            existing.setAttribute(attr.name, attr.value);
          }
        }
        const newSlots = Array.from(placeholder.childNodes);
        if (newSlots.length > 0 && placeholder.localName === "leo-include") {
          const hasSpecificSlots = newSlots.some(n => n.nodeType === Node.ELEMENT_NODE && n.hasAttribute("slot"));
          if (hasSpecificSlots || existing.childNodes.length === 0) {
            existing.replaceChildren(...newSlots);
          }
        }
        const instanceState = this.componentInstances.get(existing);
        if (instanceState) {
          instanceState.transitionId = id;
        }
        placeholder.replaceWith(existing);
      }

      this.removePageScripts();
      this.root.replaceChildren(...pageNodes);
      this.root.setAttribute("aria-busy", "false");
      this.root.dataset.leoPath = target.resolved.requestedPath;
      this.setPageTitle(route.title || parsed.title || document.title);
      this.hydrateLinks(this.root);
      this.syncNavigation(target.resolved.key);

      this.activeUrl = target.url;
      this.activeRoute = target.resolved;
      this.routeData = routeData;
      this.currentContext = routeContext;
      await this.updateShellComponents();
      await this.updatePersistentComponents(preservedElements);
      await this.mountComponents(id);
      if (signal.aborted || id !== this.navigationId) return;

      await this.runScripts(scripts, pageUrl, id, signal);
      if (signal.aborted || id !== this.navigationId) return;

      const loaderDelay = this.parseLoaderTiming(route?.loaderTiming ?? this.config?.loaderTiming);
      if (loaderDelay > 0) {
        await new Promise((resolve) => setTimeout(resolve, loaderDelay));
      }

      this.hideLoader();
      if (options.scroll !== false) this.scrollToLocation(target.url);

      const routeDetail = {
        path: target.resolved.requestedPath,
        params: routeContext.params,
        data: routeData,
        route: target.resolved.route,
        found: target.resolved.found,
        url: target.url.href,
      };
      document.dispatchEvent(new CustomEvent("leo:routechange", { detail: routeDetail }));
      window.dispatchEvent(new CustomEvent("leo:routechange", { detail: routeDetail }));
    } catch (error) {
      if (signal.aborted || id !== this.navigationId) return;
      await this.disposeComponents((state) => state.scope === "page");
      this.hideLoader();
      this.root.setAttribute("aria-busy", "false");
      this.showError(error);
      console.error("[LEO] Navigation failed:", error);
    } finally {
      this.isTransitioning = false;
    }
  }

  collectScripts(parsed, route) {
    const scripts = Array.from(parsed.querySelectorAll("script"))
      .filter((script) => !script.hasAttribute("data-leo-shell"))
      .map((script) => ({
        src: script.getAttribute("src"),
        type: script.getAttribute("type") || "",
        text: script.textContent || "",
        attributes: Array.from(script.attributes).filter(
          (attribute) =>
            attribute.name !== "src" &&
            attribute.name !== "data-leo-shell" &&
            attribute.name !== "data-leo-page-script",
        ),
      }));

    for (const entry of route.scripts || []) {
      if (typeof entry === "string") {
        scripts.push({
          src: entry,
          type: "module",
          text: "",
          attributes: [],
          configRelative: true,
        });
      } else if (entry && typeof entry.src === "string") {
        scripts.push({
          src: entry.src,
          type: entry.type || "module",
          text: "",
          attributes: [],
          configRelative: true,
        });
      }
    }

    parsed.querySelectorAll("script").forEach((script) => script.remove());
    return scripts.filter((script) => isExecutableScript(script.type));
  }

  collectPageNodes(parsed, pageUrl) {
    const sourceRoot = parsed.querySelector("#pidRoot") || parsed.body;
    const nodes = Array.from(sourceRoot.childNodes);

    for (const node of nodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      for (const element of [node, ...node.querySelectorAll("[src], [href], [poster], [action]")]) {
        for (const attribute of ["src", "href", "poster", "action"]) {
          if (!element.hasAttribute(attribute)) continue;
          if (attribute === "href" && element.hasAttribute(ROUTE_ATTRIBUTE)) continue;
          const value = element.getAttribute(attribute).trim();
          if (!value || isSpecialUrl(value)) continue;
          element.setAttribute(attribute, new URL(value, pageUrl).href);
        }
      }
    }

    return nodes;
  }

  async replacePageStyles(parsed, route, pageUrl, id) {
    document.head.querySelectorAll("[data-leo-page-style]").forEach((style) => style.remove());

    const links = [
      ...Array.from(parsed.querySelectorAll('link[rel~="stylesheet"][href]')).map((link) =>
        link.getAttribute("href"),
      ),
      ...(Array.isArray(route.styles) ? route.styles : []),
    ];

    for (const href of links) {
      const resolvedUrl = new URL(href, pageUrl);
      const alreadyLoaded = Array.from(
        document.head.querySelectorAll('link[rel~="stylesheet"][href]'),
      ).some((link) => link.href === resolvedUrl.href);
      if (alreadyLoaded) continue;

      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = resolvedUrl.href;
      link.dataset.leoPageStyle = String(id);
      document.head.append(link);
    }

    const inlineStyles = Array.from(parsed.querySelectorAll("style")).map(
      (style) => style.textContent || "",
    );
    for (const css of inlineStyles) {
      const alreadyLoaded = Array.from(document.head.querySelectorAll("style")).some(
        (style) => style.textContent === css,
      );
      if (alreadyLoaded) continue;

      const copy = document.createElement("style");
      copy.dataset.leoPageStyle = String(id);
      copy.textContent = css;
      document.head.append(copy);
    }
  }

  async runScripts(scripts, pageUrl, id, signal) {
    for (const description of scripts) {
      if (signal.aborted || id !== this.navigationId) return;

      const script = document.createElement("script");
      script.dataset.leoPageScript = String(id);
      for (const attribute of description.attributes) {
        script.setAttribute(attribute.name, attribute.value);
      }
      if (description.type) script.type = description.type;

      if (description.src) {
        let sourceUrl = new URL(
          description.src,
          description.configRelative ? this.dataUrl : pageUrl,
        );
        if (description.type.trim().toLowerCase() === "module") {
          sourceUrl.searchParams.set("__leo_visit", String(id));
        }
        script.src = sourceUrl.href;
        script.async = false;

        await new Promise((resolve, reject) => {
          script.addEventListener("load", resolve, { once: true });
          script.addEventListener(
            "error",
            () => reject(new Error(`Could not load page script ${sourceUrl.pathname}.`)),
            { once: true },
          );
          document.body.append(script);
        });
      } else {
        script.textContent = description.text;
        document.body.append(script);
      }
    }
  }

  removePageScripts() {
    document.querySelectorAll("[data-leo-page-script]").forEach((script) => script.remove());
  }

  showLoader() {
    this.loaderRoot.replaceChildren();
    if (this.loaderMarkup) {
      const parsed = new DOMParser().parseFromString(this.loaderMarkup, "text/html");
      this.loaderRoot.innerHTML = parsed.body.innerHTML;
    }
    this.loaderRoot.hidden = false;
    this.loaderRoot.setAttribute("aria-hidden", "false");
  }

  parseLoaderTiming(val) {
    if (val === undefined || val === null) return 0;
    if (typeof val === 'number') return (val > 0 && val <= 30) ? val * 1000 : val;
    if (typeof val === 'string') {
      const s = val.trim().toLowerCase();
      if (s.endsWith('ms')) return parseFloat(s) || 0;
      if (s.endsWith('s')) return (parseFloat(s) || 0) * 1000;
      const n = parseFloat(s);
      if (!isNaN(n)) return (n > 0 && n <= 30) ? n * 1000 : n;
    }
    return 0;
  }

  hideLoader() {
    this.loaderRoot.hidden = true;
    this.loaderRoot.setAttribute("aria-hidden", "true");
  }

  showError(error) {
    const message = error instanceof Error ? error.message : String(error);
    const panel = document.createElement("section");
    panel.className = "leo-error";
    panel.setAttribute("role", "alert");

    const heading = document.createElement("h1");
    heading.textContent = "LEO could not load this page";
    const detail = document.createElement("p");
    detail.textContent = message;
    panel.append(heading, detail);
    this.root.replaceChildren(panel);
  }

  hydrateLinks(scope) {
    const elements = this.elementsInTree(scope, `[${ROUTE_ATTRIBUTE}]`);

    const current = new URL(window.location.href);
    for (const element of elements) {
      const destination = element.getAttribute(ROUTE_ATTRIBUTE);
      if (!destination) continue;
      const url = this.makeUrl(destination, current);
      if (url.origin === window.location.origin && element instanceof HTMLAnchorElement) {
        element.href = `${url.pathname}${url.search}${url.hash}`;
      }
    }
  }

  syncNavigation(routeKey) {
    this.elementsInTree(document, `[${ROUTE_ATTRIBUTE}]`).forEach((element) => {
      if (!element.classList.contains("nav-item")) return;
      const path = this.routePath(this.makeUrl(element.getAttribute(ROUTE_ATTRIBUTE), new URL(window.location.href)));
      const resolved = resolveRoute(this.config, path);
      const active = resolved.found && resolved.key === routeKey;
      element.classList.toggle("is-active", active);
      if (active) element.setAttribute("aria-current", "page");
      else element.removeAttribute("aria-current");
    });
  }

  scrollToLocation(url) {
    if (url.hash) {
      const id = decodeURIComponent(url.hash.slice(1));
      requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView());
      return;
    }
    window.scrollTo(0, 0);
  }

  setPageTitle(title) {
    if (title) document.title = title;
  }

  handleClick(event) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }

    const origin = event.target;
    const element =
      event
        .composedPath()
        .find(
          (node) =>
            node instanceof Element && node.hasAttribute(ROUTE_ATTRIBUTE),
        ) ||
      (origin instanceof Element
        ? origin.closest(`[${ROUTE_ATTRIBUTE}]`)
        : null);
    if (!element) return;

    const anchor = element instanceof HTMLAnchorElement ? element : null;
    if (
      anchor &&
      ((anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download"))
    ) {
      return;
    }

    const destination = element.getAttribute(ROUTE_ATTRIBUTE);
    if (!destination) return;
    const url = this.makeUrl(destination, new URL(window.location.href));
    if (url.origin !== window.location.origin) return;

    event.preventDefault();
    if (this.config.mode === "multi-page" || this.config.mode === "document") {
      window.location.assign(url.href);
      return;
    }

    void this.transition(url, { history: "push", scroll: true });
  }

  handlePopState() {
    void this.transition(window.location.href, { history: "none", scroll: true });
  }

  navigate(destination, options = {}) {
    return this.transition(destination, {
      history: options.replace ? "replace" : "push",
      replace: Boolean(options.replace),
      scroll: options.scroll !== false,
    });
  }

  go(destination, options = {}) {
    return this.navigate(destination, options);
  }
}

export async function startLeo(options = {}) {
  const router = new LeoRouter(options);
  const api = {
    version: "0.1.0",
    go: (path, navigationOptions) => router.go(path, navigationOptions),
    navigate: (path, navigationOptions) => router.navigate(path, navigationOptions),
    get currentPath() {
      return router.activeRoute?.requestedPath || router.routePath(new URL(window.location.href));
    },
    get currentRoute() {
      return router.currentContext;
    },
    get routeData() {
      return router.routeData;
    },
    get config() {
      return router.config;
    },
    getPersistent: (key) => router.persistentStash.get(key) || null,
    get persistentComponents() {
      return router.persistentStash;
    },
  };

  window.LEO = Object.freeze(api);
  await router.start();
  return router;
}