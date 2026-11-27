const test = require('node:test');
const assert = require('node:assert/strict');
const { formatOfferMessage, humanizeTitle } = require('../src/services/shopee/formatter');

const affiliateUrl = 'https://s.shopee.com.br/abc?sub_id=cau%2Bteste&x=1%262';

test('apresenta preço único, avaliação e vendas sem modificar o link', () => {
  const offer = { title: 'Secador de cabelo', priceMin: 89.9, rating: 4.9, sales: 1200, affiliateUrl };
  const text = formatOfferMessage(offer);
  assert.match(text, /💰 Por R\$\s?89,90/);
  assert.match(text, /⭐ Avaliação: 4,9/);
  assert.match(text, /🛍️ 1\.200 vendidos/);
  assert.ok(text.endsWith(affiliateUrl));
  assert.equal(offer.title, 'Secador de cabelo');
});

test('apresenta variação real e omite avaliação e vendas ausentes', () => {
  const text = formatOfferMessage({title:'Kit de lençóis',priceMin:39.49,priceMax:157.96,affiliateUrl});
  assert.match(text, /De R\$\s?39,49 a R\$\s?157,96/);
  assert.doesNotMatch(text, /Avaliação|vendidos|OFF|Desconto/);
});

test('humaniza maiúsculas preservando siglas e especificações', () => {
  const title = humanizeTitle('CABO USB 4K LED MODELO A15 220V 2M - PROMOÇÃO IMPERDÍVEL');
  assert.match(title, /USB/); assert.match(title, /4K/); assert.match(title, /LED/);
  assert.match(title, /A15/); assert.match(title, /220V/); assert.match(title, /2M/);
  assert.doesNotMatch(title, /PROMOÇÃO IMPERDÍVEL/i);
});

test('mantém marca, modelo e dimensões de título misto', () => {
  const title = 'Fone JBL Tune 510BT Bluetooth 40 mm - Oferta imperdível';
  const output = humanizeTitle(title);
  assert.match(output, /JBL Tune 510BT/); assert.match(output, /40 mm/);
  assert.doesNotMatch(output, /oferta imperdível/i);
});

test('usa título original quando limpeza remove todo conteúdo', () => {
  assert.equal(humanizeTitle('PROMOÇÃO IMPERDÍVEL'), 'PROMOÇÃO IMPERDÍVEL');
});

test('alterna aberturas e chamadas entre mensagens consecutivas', () => {
  const first = formatOfferMessage({title:'Produto um',affiliateUrl});
  const second = formatOfferMessage({title:'Produto dois',affiliateUrl});
  assert.notEqual(first.split('\n')[0], second.split('\n')[0]);
  assert.notEqual(first.split('\n').at(-2), second.split('\n').at(-2));
});

test('fallback preserva título e URL se apresentação falhar', () => {
  const offer = { title:'Produto real', affiliateUrl, get priceMin() { throw new Error('erro'); } };
  const text = formatOfferMessage(offer);
  assert.match(text, /Produto real/); assert.ok(text.includes(affiliateUrl));
});

test('conversor usa formatador e preserva a imagem, URL e título original', async () => {
  const { Repository } = require('../src/database/repository');
  const { OfferConverter } = require('../src/services/offers/converter');
  const repository = new Repository();
  const converter = new OfferConverter({repository, shopeeClient: {
    async resolveShopeeUrl() { return {itemId:'1',shopId:'2',canonicalUrl:'https://shopee.com.br/product/2/1'}; },
    async getProductOffer() { return {title:'FONE JBL USB 220V',priceMin:89.9,imageUrl:'https://down-br.img.susercontent.com/image'}; },
    async generateShortLink() { return {shortLink:affiliateUrl,subIds:[]}; },
  }});
  const result = await converter.convertLink({url:'https://shopee.com.br/product/2/1'});
  assert.equal(result.product.title, 'FONE JBL USB 220V');
  assert.equal(result.product.imageUrl, 'https://down-br.img.susercontent.com/image');
  assert.ok(result.formattedMessage.endsWith(affiliateUrl));
  assert.match(result.formattedMessage, /JBL USB 220V/);
});

test('mensagem formatada segue como legenda da imagem no envio simulado', async () => {
  const { WhatsAppEngine } = require('../src/services/whatsapp/engine');
  const { Repository } = require('../src/database/repository');
  const engine = new WhatsAppEngine({repository:new Repository()});
  engine.status = 'CONNECTED';
  let captured;
  engine.sock = {
    user: {id:'100:2@s.whatsapp.net'},
    async groupMetadata() {return {announce:false,participants:[]};},
    async sendMessage(jid, content, options) {captured = {jid,content}; return {key:{id:options.messageId}};},
  };
  const text = formatOfferMessage({title:'Bolsa escolar',priceMin:25,affiliateUrl});
  const send = await engine.prepareGroupText('123456789@g.us', 'https://down-br.img.susercontent.com/image');
  await send.send(text);
  assert.equal(captured.jid, '123456789@g.us');
  assert.equal(captured.content.caption, text);
  assert.deepEqual(captured.content.image, {url:'https://down-br.img.susercontent.com/image'});
  assert.ok(captured.content.caption.endsWith(affiliateUrl));
});

test('fallback mantém link quando o título não pode ser lido', () => {
  const offer = {affiliateUrl, get title() {throw new Error('título indisponível');}};
  assert.ok(formatOfferMessage(offer).endsWith(affiliateUrl));
});
