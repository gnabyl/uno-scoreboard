# Getting Started with Create React App

This project was bootstrapped with [Create React App](https://github.com/facebook/create-react-app).

## Multiplayer rooms (Supabase)

Rooms live in Postgres and are reached through Supabase RPCs; clients never
write tables directly.

### One-time setup

1. **Enable anonymous sign-ins** - Supabase dashboard → Authentication →
   Providers → Anonymous → Enable. Each device gets a stable anonymous user on
   first visit. Without this toggle every RPC fails with `auth_required`.
2. **Apply the schema** - run
   [`../supabase/migrations/20261018201500_init_rooms.sql`](../supabase/migrations/20261018201500_init_rooms.sql)
   in the SQL editor, or `supabase db push` if you use the CLI.
3. **Set the client env vars** locally in `.env` and in Vercel for every
   environment (the Vercel Supabase integration injects `SUPABASE_URL` and
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`, but Create React App only exposes
   `VITE_*` names to the browser):

   ```
   VITE_SUPABASE_URL=...
   VITE_SUPABASE_ANON_KEY=...
   ```

### How it works

- Every mutation is a single RPC (`cmd_add_round`, `cmd_set_score`, …) carrying
  `p_base_version` and `p_request_id`.
- Room codes are 8 characters from a 31-character alphabet. `join_room` and
  `create_room` each allow 10 calls per minute and 50 per hour per identity
  (`PT429`), so codes cannot be enumerated and rooms cannot be mass-created.
- Each room accepts up to 120 mutations per minute and 600 per hour. The count
  comes from `room_events`, so replaying a `request_id` is free and only
  committed writes consume the budget.
- The server bumps `rooms.version` with a compare-and-swap, which serializes
  writes per room. A stale `base_version` raises `PT409`; retrying the same
  `request_id` is replayed instead of rejected.
- Clients subscribe to `rooms.version` over Realtime and refetch
  [`get_room`](./src/api-helper/rooms.ts) on every bump, so a dropped event only
  delays a refresh and never loses state.
- A blank score is `NULL`. Totals and round winners stay derived on the client;
  nothing aggregate is stored.
- The API layer is [`src/api-helper/rooms.ts`](./src/api-helper/rooms.ts) with the client in
  [`src/api-helper/supabase.ts`](./src/api-helper/supabase.ts).

### Conflict policy

`setScore` retries once automatically when the conflicting change touched a
_different_ cell; if the same cell changed it throws `ScoreConflictError` with
the fresh snapshot. Destructive operations surface `VersionConflictError` so the
UI can ask for confirmation.

## Local development

Run the dev server through the Vercel CLI so the SPA and the serverless
functions share one origin:

```
npm run vercel:dev
```

Then open <http://localhost:5173>. `vercel dev` binds port 5173 and starts
`npm run dev` (Vite) as its dev command on an internal port - the port is
passed to Vite through the `$PORT` placeholder in
[`vercel.json`](./vercel.json), so Vercel and Vite can never disagree about it.
That means:

- the app is served from 5173, and
- `/api/model` is handled by the real [`api/model.ts`](./api/model.ts) function,
  which signs a short-lived URL for the private model blob using
  `BLOB_READ_WRITE_TOKEN` from `.env`.

Running `npm run dev` on its own starts Vite without the functions. The SPA
still loads, but `/api/model` resolves to the function's source instead of
JSON, and there is no `public/model/` copy to fall back to, so card scanning
cannot load the detector. Use `npm run vercel:dev` for anything that scans.

## TypeScript

The app is written in TypeScript. `npm run typecheck` runs `tsc --noEmit` over
`src/`, `api/` and the config files. The project currently compiles with
`strict: false` (see [`tsconfig.json`](./tsconfig.json)) - a lenient starting
point; tighten it incrementally. Test files (`*.test.ts(x)`, `setupTests.ts`)
are excluded from the typecheck until a test runner is wired up.

The serverless function has its own [`api/tsconfig.json`](./api/tsconfig.json).
Vercel resolves a tsconfig **from the function's own directory**, so without
that file `api/model.ts` inherits `module: ESNext` from the app config, Vercel
transpiles the function to ESM, and the Node.js runtime then loads the emitted
`api/model.js` as CommonJS and fails with `Cannot use import statement outside
a module`. Pinning `module: NodeNext` there makes Vercel emit CommonJS for the
function, since [`package.json`](./package.json) has no `"type": "module"`.

## Available Scripts

In the project directory, you can run:

### `npm start`

Runs the app in the development mode.\
Open [http://localhost:3000](http://localhost:3000) to view it in your browser.

The page will reload when you make changes.\
You may also see any lint errors in the console.

### `npm test`

Launches the test runner in the interactive watch mode.\
See the section about [running tests](https://facebook.github.io/create-react-app/docs/running-tests) for more information.

### `npm run build`

Builds the app for production to the `build` folder.\
It correctly bundles React in production mode and optimizes the build for the best performance.

The build is minified and the filenames include the hashes.\
Your app is ready to be deployed!

See the section about [deployment](https://facebook.github.io/create-react-app/docs/deployment) for more information.

### `npm run eject`

**Note: this is a one-way operation. Once you `eject`, you can't go back!**

If you aren't satisfied with the build tool and configuration choices, you can `eject` at any time. This command will remove the single build dependency from your project.

Instead, it will copy all the configuration files and the transitive dependencies (webpack, Babel, ESLint, etc) right into your project so you have full control over them. All of the commands except `eject` will still work, but they will point to the copied scripts so you can tweak them. At this point you're on your own.

You don't have to ever use `eject`. The curated feature set is suitable for small and middle deployments, and you shouldn't feel obligated to use this feature. However we understand that this tool wouldn't be useful if you couldn't customize it when you are ready for it.

## Learn More

You can learn more in the [Create React App documentation](https://facebook.github.io/create-react-app/docs/getting-started).

To learn React, check out the [React documentation](https://reactjs.org/).

### Code Splitting

This section has moved here: [https://facebook.github.io/create-react-app/docs/code-splitting](https://facebook.github.io/create-react-app/docs/code-splitting)

### Analyzing the Bundle Size

This section has moved here: [https://facebook.github.io/create-react-app/docs/analyzing-the-bundle-size](https://facebook.github.io/create-react-app/docs/analyzing-the-bundle-size)

### Making a Progressive Web App

This section has moved here: [https://facebook.github.io/create-react-app/docs/making-a-progressive-web-app](https://facebook.github.io/create-react-app/docs/making-a-progressive-web-app)

### Advanced Configuration

This section has moved here: [https://facebook.github.io/create-react-app/docs/advanced-configuration](https://facebook.github.io/create-react-app/docs/advanced-configuration)

### Deployment

This section has moved here: [https://facebook.github.io/create-react-app/docs/deployment](https://facebook.github.io/create-react-app/docs/deployment)

### `npm run build` fails to minify

This section has moved here: [https://facebook.github.io/create-react-app/docs/troubleshooting#npm-run-build-fails-to-minify](https://facebook.github.io/create-react-app/docs/troubleshooting#npm-run-build-fails-to-minify)

## Styling

The UI is styled with [Tailwind CSS](https://tailwindcss.com/). Vite runs Tailwind through its PostCSS pipeline ([`postcss.config.mts`](./postcss.config.mts)), so there is no separate build step.

- Design tokens (colors, shadows, fonts) live in [`tailwind.config.ts`](./tailwind.config.ts).
- [`src/index.css`](./src/index.css) loads the Tailwind layers and global body styles.
- Utility classes are applied directly in JSX. Shared class strings for buttons, score fields, and table cells are defined at the top of [`src/components/ui.tsx`](./src/components/ui.tsx).

## Localization

The app ships in English and Vietnamese. There is no i18n library - the setup
is a small React context in [`src/i18n/`](./src/i18n/):

- [`translations.ts`](./src/i18n/translations.ts) holds one flat dictionary per
  language. English is the source of truth: its keys define the `TranslationKey`
  union, and every other language is typed as `Record<TranslationKey, string>`,
  so a missing translation is a compile error.
- [`index.tsx`](./src/i18n/index.tsx) exports `I18nProvider`, `useTranslation`
  (just the `t` function) and `useI18n` (language plus a setter). The provider is
  mounted in [`src/index.tsx`](./src/index.tsx); it keeps `<html lang>` and the
  document title in sync.
- Strings interpolate `{name}`-style tokens, e.g.
  `t('board.round', { n: roundIndex + 1 })`.

The active language is picked on first load from `localStorage` (key
`uno.lang`), then the browser's preferred languages, then English. Users change
it with the header [`LanguageSwitcher`](./src/components/LanguageSwitcher.tsx),
which persists the choice.

### Adding a language

1. Add the language to `LANGUAGES` in [`src/i18n/index.tsx`](./src/i18n/index.tsx).
2. Add its dictionary to `dictionaries` there.
3. Copy the keys from `en` and translate the values - TypeScript flags anything
   missing.

`describeRoomError` in [`src/lib/roomCode.ts`](./src/lib/roomCode.ts) takes the
`t` function so API errors are shown in the active language.
