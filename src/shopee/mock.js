'use strict';

/**
 * Mock de produtos Shopee para testar o pipeline sem credenciais reais.
 * Ative com: SHOPEE_TEST_MODE=true
 */

const MOCK_PRODUCTS = [
  {
    shopee_id:      'mock_001',
    name:           'Fone Bluetooth TWS Premium com Cancelamento de Ruído',
    image_url:      'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=800',
    price_original: 189.90,
    price_discount: 89.90,
    commission_pct: 12.5,
    short_desc:     'Qualidade de som excepcional, até 30h de bateria, resistente à água IPX5.',
    product_url:    'https://shopee.com.br/mock/fone-001',
    affiliate_link: 'https://s.shopee.com.br/mock001',
  },
  {
    shopee_id:      'mock_002',
    name:           'Smartwatch Fitness Tracker Monitor Cardíaco GPS',
    image_url:      'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=800',
    price_original: 299.00,
    price_discount: 149.00,
    commission_pct: 10.0,
    short_desc:     'Monitore sua saúde 24h. 120 modos esportivos, tela AMOLED, bateria 7 dias.',
    product_url:    'https://shopee.com.br/mock/watch-002',
    affiliate_link: 'https://s.shopee.com.br/mock002',
  },
  {
    shopee_id:      'mock_003',
    name:           'Mini Projetor Portátil Full HD 3000 Lumens WiFi',
    image_url:      'https://images.unsplash.com/photo-1478720568477-152d9b164e26?w=800',
    price_original: 450.00,
    price_discount: 259.90,
    commission_pct: 9.5,
    short_desc:     'Transforme qualquer parede em cinema. Conecta ao celular sem fio.',
    product_url:    'https://shopee.com.br/mock/projetor-003',
    affiliate_link: 'https://s.shopee.com.br/mock003',
  },
];

module.exports = { MOCK_PRODUCTS };
