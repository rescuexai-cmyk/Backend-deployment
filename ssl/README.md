Place production TLS certificates in this folder for the nginx container mount.

Required filenames:
- `fullchain.pem`
- `privkey.pem`

Expected nginx paths:
- `/etc/nginx/ssl/fullchain.pem`
- `/etc/nginx/ssl/privkey.pem`

Typical setup on server:
1. Obtain/renew certs with certbot.
2. Copy or symlink cert files into `./ssl/` with the exact names above.
3. Run `docker-compose -f docker-compose.prod.yml exec nginx nginx -t`.
4. Run `docker-compose -f docker-compose.prod.yml exec nginx nginx -s reload`.
