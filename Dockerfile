FROM public.ecr.aws/lambda/nodejs:18 AS builder

RUN yum install -y \
    atk cups-libs gtk3 libXcomposite alsa-lib \
    libXcursor libXdamage libXext libXi libXrandr libXScrnSaver \
    libXtst pango at-spi2-atk libXt xorg-x11-server-Xvfb \
    xorg-x11-xauth dbus-glib nss mesa-libgbm jq unzip \
    xorg-x11-utils xorg-x11-fonts* wget libnss3 \
    mesa-libGL mesa-libEGL mesa-libGLU && \
    yum clean all

RUN corepack enable && corepack prepare yarn@stable --activate

WORKDIR /var/task
COPY package.json yarn.lock ./

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
RUN yarn install

COPY tsconfig.json ./
COPY src ./src
RUN yarn build

FROM public.ecr.aws/lambda/nodejs:18

COPY --from=builder /usr/lib64/ /usr/lib64/
COPY --from=builder /usr/lib/ /usr/lib/

WORKDIR /var/task
COPY --from=builder /var/task/dist ./dist
COPY --from=builder /var/task/node_modules ./node_modules
COPY package.json ./

CMD ["dist/lambda.handler"]
