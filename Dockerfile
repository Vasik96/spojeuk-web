FROM node:22-alpine
WORKDIR /app
COPY . .
# Jízdní řády a trasy spojů se sestaví přímo při buildu image (GitHub release), takže kontejner naběhne hned.
# Nové jízdní řády si server sám stáhne za běhu, když je stránka otevřená a data jsou starší než DATA_REFRESH_H.
RUN node scripts/build-data.mjs && chown -R node:node /app/public/data
ENV NODE_ENV=production PORT=8080 POLL_MODE=lazy
EXPOSE 8080
USER node
CMD ["node", "server.mjs"]
