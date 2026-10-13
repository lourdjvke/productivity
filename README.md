# LEO static export

This folder is a complete static site root. Copy the contents of this folder to your website's document root.

- No Vite, React, Next.js, package installation, or build command is needed to serve these files.
- Serve over HTTP or HTTPS. Opening index.html directly with file:// may prevent the browser from loading JSON and JavaScript modules.
- Keep the files and folders together: index.html, main.js, router.js, data.json, style.css, pig-loader.html, favicon.svg, components/, pages/, and the fallback files.
- The included _redirects file is recognized by hosts such as Netlify and Cloudflare Pages. On other hosts, configure clean paths such as /contact to serve index.html. The included 404.html can be used as a custom not-found fallback where supported.
- The example is configured for a site deployed at the domain root. If deploying under a subfolder, update basePath in data.json and the hosting fallback rule to use that prefix.

## Reusable components

Components are optional HTML fragments in components/. Include one in the shell or a route page with:

```html
<leo-include src="components/navbar.html"
  style="--leo-navbar-background: #263449; --leo-navbar-accent: #f07852"></leo-include>
```

LEO loads nested includes from the same site and renders each include in an isolated Shadow DOM root. Component HTML may use native slots and one external same-origin ES module; its mount lifecycle receives include props and route data, and cleanup runs when page components are removed. Inline and classic component scripts are rejected.

Routes may use `:name` segments and a `data` JSON path such as `data/posts/:slug.json`. The matched parameter is URL-encoded into the path; returned JSON is available in page bindings, component lifecycle context, and `LEO.currentRoute`.

To refresh this folder from the workspace sources, run:

`pnpm --filter @workspace/leo-router run export:static`

That command uses Node's built-in file utilities to copy and prepare the files; it does not run Vite.
