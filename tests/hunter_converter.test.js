const test = require('node:test');
const assert = require('node:assert/strict');
const { Repository } = require('../src/database/repository');
const { RedisClient } = require('../src/redis/client');
const { MessageDispatcher } = require('../src/services/queue/dispatcher');
const { OfferHunter } = require('../src/services/offers/hunter');
const { OfferConverter } = require('../src/services/offers/converter');
const { GroupManager } = require('../src/services/groups/manager');
const { GroupListener } = require('../src/services/groups/listener');

test('Caçador Automático: não dispara sem ativação, aplica filtros reais e evita repetidos', async () => {
  const repository = new Repository();
  const redis = new RedisClient({ isTest: true });
  const dispatcher = new MessageDispatcher({ repository, redis, whatsapp: { status: 'OFFLINE' } });

  const shopeeMock = {
    async generateShortLink({ originUrl }) {
      assert.equal(originUrl, 'https://shopee.com.br/product/10/2');
      return { shortLink: 'https://s.shopee.com.br/affiliate-test' };
    },
    async searchProducts() {
      return {
        offers: [
          {
            itemId: '1',
            shopId: '10',
            title: 'Produto Comissão Baixa',
            priceMin: 100,
            priceMax: 100,
            discountPercent: 10,
            commissionRate: 0.02, // 2% (abaixo do mínimo 8%)
            sales: 500,
            rating: 4.9,
            productUrl: 'https://shopee.com.br/product/10/1',
            offerLink: 'https://shope.ee/p1',
            imageUrl: 'https://down-br.img.susercontent.com/file/1.jpg',
          },
          {
            itemId: '2',
            shopId: '10',
            title: 'Cafeteira Elétrica Top',
            priceMin: 180,
            priceMax: 180,
            discountPercent: 35,
            commissionRate: 0.12, // 12%
            sales: 300,
            rating: 4.8,
            productUrl: 'https://shopee.com.br/product/10/2',
            offerLink: 'https://shope.ee/p2',
            imageUrl: 'https://down-br.img.susercontent.com/file/2.jpg',
          },
        ],
      };
    },
  };

  await repository.updateWhatsAppGroupConfig('120363000000000099@g.us', {
    name: 'Destino VIP',
    isDestination: true,
  });
  await repository.addHunterKeyword({ keyword: 'cafeteira' });

  const hunter = new OfferHunter({ repository, redis, shopeeClient: shopeeMock, dispatcher });
  await hunter.saveConfig({ minCommissionPercent: 8, minPrice: 50, maxPrice: 300, minSales: 100 });

  // Desativado por padrão: ciclo automático não roda
  const blocked = await hunter.runCycle({ forceManual: false });
  assert.equal(blocked.skipped, true);
  assert.equal(blocked.reason, 'hunter_disabled');

  // Ativa explicitamente
  await hunter.saveConfig({ enabled: true, maxPerRun: 3 });
  const res1 = await hunter.runCycle({ forceManual: false });
  assert.equal(res1.offersSelected, 1);
  assert.equal(res1.enqueued, 1);
  assert.equal(res1.offers[0].title, 'Cafeteira Elétrica Top');
  assert.equal(res1.offers[0].affiliate_url, 'https://s.shopee.com.br/affiliate-test');

  // Segunda execução: mesmo produto não repete
  const res2 = await hunter.runCycle({ forceManual: false });
  assert.equal(res2.offersSelected, 0);
  assert.equal(res2.enqueued, 0);
});

test('Conversor Rápido: converte via painel e responde no privado do WhatsApp quando ativado', async () => {
  const repository = new Repository();
  const redis = new RedisClient({ isTest: true });
  const privateReplies = [];

  const whatsappMock = {
    status: 'CONNECTED',
    on() {},
    off() {},
    async sendImage(jid, img, caption) {
      privateReplies.push({ jid, img, caption });
      return { messageId: 'PRIV_1' };
    },
    async sendText(jid, text) {
      privateReplies.push({ jid, text });
      return { messageId: 'PRIV_2' };
    },
  };

  const shopeeMock = {
    async resolveShopeeUrl() {
      return {
        originUrl: 'https://s.shopee.com.br/abc',
        resolvedUrl: 'https://shopee.com.br/product/44/55',
        shopId: '44',
        itemId: '55',
        canonicalUrl: 'https://shopee.com.br/product/44/55',
      };
    },
    async getProductOffer() {
      return {
        itemId: '55',
        shopId: '44',
        title: 'Kit Organizador Geladeira',
        priceMin: 49.9,
        priceMax: 49.9,
        discountPercent: 20,
        commissionRate: 0.1,
        sales: 1200,
        rating: 4.9,
        productUrl: 'https://shopee.com.br/product/44/55',
        imageUrl: 'https://down-br.img.susercontent.com/file/kit.jpg',
      };
    },
    async generateShortLink({ originUrl, subIds }) {
      return { originUrl, shortLink: 'https://shope.ee/kit55', subIds };
    },
  };

  const converter = new OfferConverter({ shopeeClient: shopeeMock, repository });
  const res = await converter.convertLink({
    url: 'https://s.shopee.com.br/abc',
    subIds: ['stories_ig'],
    requestedVia: 'panel',
  });
  assert.equal(res.shortLink, 'https://shope.ee/kit55');
  assert.match(res.formattedMessage, /Kit Organizador Geladeira/);

  const groupManager = new GroupManager({ repository, whatsapp: whatsappMock });
  await groupManager.setMirrorConfig({ privateConverterEnabled: true });
  const dispatcher = new MessageDispatcher({ repository, redis, whatsapp: whatsappMock });
  const listener = new GroupListener({
    whatsapp: whatsappMock,
    groupManager,
    shopeeClient: shopeeMock,
    converter,
    dispatcher,
    repository,
    redis,
  });

  await listener.handleIncomingMessage({
    id: 'DM_1',
    remoteJid: '5511988887777@s.whatsapp.net',
    isGroup: false,
    fromMe: false,
    type: 'text',
    text: 'Converte pra mim https://s.shopee.com.br/abc',
  });

  assert.equal(privateReplies.length, 1);
  assert.equal(privateReplies[0].jid, '5511988887777@s.whatsapp.net');
  assert.match(privateReplies[0].caption, /https:\/\/shope\.ee\/kit55/);

  const history = await repository.listConversions();
  assert.equal(history.length, 2);
});
