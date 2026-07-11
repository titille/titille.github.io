# Portfolio / CV

My personal portfolio and CV, built with [Astro](https://astro.build) and deployed to GitHub Pages.

🔗 **Live site:** https://titille.github.io

## Editing your content

All the CV content lives in one place — the `cv` object at the top of
[`src/pages/index.astro`](src/pages/index.astro). Edit the text there (name,
role, experience, projects, skills…) and the page updates automatically.

## Local development

```bash
npm install      # install dependencies (first time only)
npm run dev      # start the dev server at http://localhost:4321
npm run build    # build the static site into dist/
npm run preview  # preview the production build locally
```

## Deployment

Every push to the `main` branch triggers the GitHub Actions workflow in
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml), which builds the
site and publishes it to GitHub Pages. No manual step needed.

> One-time setup: in the repo **Settings → Pages**, set the source to
> **GitHub Actions**.
