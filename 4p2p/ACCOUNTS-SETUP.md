# Player accounts -- setup (Railway)

All settings are Railway **Variables** (project > your service > Variables). Redeploy after changing them.

| Variable | What it is | Required? |
|---|---|---|
| `DATA_DIR` | Folder on the Railway **Volume** (e.g. `/data`). Accounts + photos live here. | YES (else accounts vanish on redeploy) |
| `PUBLIC_URL` | `https://28gulan.com` -- used in email links | YES |
| `BREVO_API_KEY` | Brevo > SMTP & API > API Keys | YES (email sign-up / reset) |
| `MAIL_FROM` | A sender address verified in Brevo | YES |
| `MAIL_FROM_NAME` | Name on the email, default `28 Gulan` | no |
| `GOOGLE_CLIENT_ID` | Google Cloud OAuth Web client ID | no (Google button hidden until set) |
| `MAX_USERS` | default 100 | no |
| `ADMIN_SECRET` / `VOICE_PASSWORD` | change from the defaults! | strongly |

Voice chat is for signed-in players (guests are asked to sign in; the old voice password is no longer asked).

Admin panel > **Users** shows slots used, whether email/Google are ready, and lets you switch off / confirm / delete accounts.
