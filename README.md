# SFPM inspections

Move-in / move-out unit condition inspection for Stress Free Property Management, served at https://inspections.stressfreepm.ca.

Next.js 16 static export (App Router, TypeScript), same design system as the maintenance portal. No backend: reports, photos (IndexedDB) and signatures stay on the device until the inspector downloads or shares the PDF. Server submit is a stub, see `src/lib/submit-report.ts`.

    npm install
    npm run dev       # http://localhost:3000
    ./deploy.sh       # build + publish to gh-pages
