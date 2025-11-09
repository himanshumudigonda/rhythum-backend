# Render deployment for Rhythum backend

Repo name: rhythum-backend
Database name: rhythum-db
Region: Frankfurt

Steps to deploy:

1. Push this backend folder to a new GitHub repo (e.g. https://github.com/YOURNAME/rhythum-backend).
2. Go to https://render.com and connect your GitHub account.
3. From Render dashboard, click "New" -> "Web Service".
   - Select your repo and branch (main).
   - Render will read render.yaml and provision services: web + Postgres.
4. After deploy, open the created Postgres database from the Render dashboard and copy the DATABASE_URL.
5. In the web service settings -> Environment -> set:
   - DATABASE_URL = <paste the DATABASE_URL from the Postgres service>
   - JIOSAAVN_NODE_URL = http://<your_node_jiosaavn_host>:3000 (if you host JioSaavn node separately)
6. Trigger a deploy (or redeploy) so the web service picks up the DATABASE_URL env var.
7. The server will auto-create tables on startup (migrations.sql also included).

Notes:
- If JioSaavn node runs locally on your machine, you must host it publicly or use a hosted JioSaavn node; otherwise the backend won't fetch JioSaavn results remotely.