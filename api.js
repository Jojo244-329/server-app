// api.js (FINAL)
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const serverless = require('serverless-http');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const app = express();

app.use(cors());
app.use(express.json());




const fbPixelId ='1134293725260676';
const fbAccessToken ='EAAJk6GQkc6UBPJg0msqpANhorrYuPUdO2uxBjX48xPfhB2xlWpdnWktAjS0hdx63ZBKAl4BuNHh6iZCtahkRaD77oComun4VjjcZCRq1Nj2olpc3GcjzLWkl9HEZAS3KJIlBAfeRw7tMZANBw3y8YvMS6EUdtl2ZCu9FGHIqpCGlPHI6FqLZB2jgE7x3qDu8hjK5gZDZD';
const UTMIFY_TOKEN ='yWZCZFgh8RKrNBPJ4feDMtSIYo0mu1ylNraP';
const POSTBACK_URL = process.env.POSTBACK_URL || 'https://seu-dominio.com/api/pix-webhook';

// 🔧 Helpers
function hashSHA256(value) {
  return crypto
    .createHash('sha256')
    .update(String(value || '').trim().toLowerCase())
    .digest('hex');
}

// ===================== GERAR PIX (Gate novo / Verso) =====================
app.post('/api/gerar-pix', async (req, res) => {
  try {
      const { nome, cpf, email, celular, valor, produto } = req.body;
  
      if (!cpf || cpf.length !== 11 || !/^\d+$/.test(cpf)) {
        return res.status(400).json({ error: "CPF inválido" });
      }
  
      if (!email || !email.includes("@")) {
        return res.status(400).json({ error: "Email inválido" });
      }
  
      if (!celular || celular.length < 10) {
        return res.status(400).json({ error: "Celular inválido" });
      }
  
      if (!valor || isNaN(valor) || valor < 100) {
        return res.status(400).json({ error: "Valor inválido" });
      }
  
      const intValor = parseInt(valor);
  
    const payload = {
    amount: intValor,
    paymentMethod: "pix",
    pix: {
      expiresInDays: 2 // define o vencimento do QR Code
    },
    customer: {
      name: nome,
      email,
      document: { number: cpf, type: "cpf" },
      phone: celular
    },
    shipping: {
      fee: 0,
      address: {
        street: req.body.rua || "Rua Desconhecida",
        streetNumber: "SN",
        complement: "",
        zipCode: req.body.cep || "00000000",
        neighborhood: req.body.bairro || "Centro",
        city: req.body.cidade || "Cidade",
        state: "SP",
        country: "BR"
      }
    },
    items: [
      {
        title: produto,
        unitPrice: intValor,
        quantity: 1,
        tangible: true
      }
    ]
  };
  
  
      const token = "sk_live_v2knIOxAPTdctFBmT630msIiCHEcFqb85GCcyH2dpv";
      const auth = Buffer.from(`${token}:x`).toString("base64");
  
      const response = await axios.post("https://api.velana.com.br/v1/transactions", payload, {
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Basic ${auth}`
        }
      }); 

      console.log('📦 Resposta do gateway:', response.data);
  
      res.json({
        qrCodeImage: response.data?.pix?.qrCodeImage,
        txid: response.data?.pix?.txid,
        raw: response.data
      });

    // (Opcional) Disparos de pixel de checkout aqui — não bloqueiam a resposta
    try {
      await axios.post(`https://graph.facebook.com/v18.0/${fbPixelId}/events`, {
        data: [
          {
            event_name: 'InitiateCheckout',
            event_time: Math.floor(Date.now() / 1000),
            event_id: uuidv4(),
            action_source: 'website',
            user_data: {
              em: [hashSHA256(email)],
              ph: [hashSHA256(celular)],
            },
            custom_data: {
              currency: 'BRL',
              value: amount / 100, // reais
              content_name: produto,
            },
          },
        ],
        access_token: fbAccessToken,
      });
    } catch (fbErr) {
      console.warn('FB Pixel InitiateCheckout error:', fbErr.response?.data || fbErr.message);
    }
  } catch (err) {
    console.error('💥 ERRO AO GERAR PIX:', err.response?.data || err.message);
    res
      .status(err.response?.status || 500)
      .json({ error: 'Erro ao gerar Pix', details: err.response?.data || err.message });
  }
});



// ===================== WEBHOOK (Verso + compat) =====================
app.post('/api/pix-webhook', async (req, res) => {
  try {
    const body = req.body;

    const isVerso = !!body?.data;
    const status = isVerso ? body.data?.status : body?.status;
    const paymentMethod = isVerso ? body.data?.paymentMethod : body?.paymentMethod;

    if (status === 'paid' && (paymentMethod === 'pix' || !paymentMethod)) {
      const data = isVerso ? body.data : body;

      const email = data?.customer?.email || '';
      const celular = data?.customer?.phone || '';
      const produto = data?.items?.[0]?.title || 'Produto';
      const amountInCents = Number(data?.amount || 0);
      const amount = amountInCents / 100;

      // 📈 Facebook Purchase
      try {
        await axios.post(`https://graph.facebook.com/v18.0/${fbPixelId}/events`, {
          data: [
            {
              event_name: 'Purchase',
              event_time: Math.floor(Date.now() / 1000),
              event_id: uuidv4(),
              action_source: 'website',
              user_data: {
                em: [hashSHA256(email)],
                ph: [hashSHA256(celular)],
              },
              custom_data: {
                currency: 'BRL',
                value: amount, // reais
                content_name: produto,
              },
            },
          ],
          access_token: fbAccessToken,
        });
      } catch (fbErr) {
        console.warn('FB Pixel Purchase error:', fbErr.response?.data || fbErr.message);
      }

      // 🧾 UTMify
      try {
        await axios.post(
          'https://api.utmify.com.br/api-credentials/orders',
          {
            orderId: body.id || body.objectId || uuidv4(),
            platform: isVerso ? 'pix-verso' : 'pix-api',
            paymentMethod: 'pix',
            status: 'paid',
            createdAt:
              data?.created_at ||
              new Date().toISOString().slice(0, 19).replace('T', ' '),
            approvedDate: new Date().toISOString().slice(0, 19).replace('T', ' '),
            refundedAt: null,
            customer: {
              name: data?.customer?.name || '',
              email,
              phone: celular,
              document: data?.customer?.document?.number || '',
              country: 'BR',
              ip: data?.customer?.ip || '0.0.0.0',
            },
            products: [
              {
                id: 'prod-pix',
                name: produto,
                planId: null,
                planName: null,
                quantity: 1,
                priceInCents: amountInCents,
              },
            ],
            trackingParameters: {
              utm_source: data?.tracking?.utm_source || null,
              utm_medium: data?.tracking?.utm_medium || null,
              utm_campaign: data?.tracking?.utm_campaign || null,
              utm_content: data?.tracking?.utm_content || null,
              utm_term: data?.tracking?.utm_term || null,
              src: null,
              sck: null,
            },
            commission: {
              totalPriceInCents: amountInCents,
              gatewayFeeInCents: 0,
              userCommissionInCents: amountInCents,
            },
            isTest: false,
          },
          { headers: { 'x-api-token': UTMIFY_TOKEN } }
        );
      } catch (uErr) {
        console.warn('UTMify error:', uErr.response?.data || uErr.message);
      }
    }

    res.status(200).json({ status: 'OK' });
  } catch (err) {
    console.error('Erro webhook:', err.message);
    res.status(500).json({ error: 'Erro Webhook' });
  }
});

// 🔥 Exportação Serverless
module.exports = app;
module.exports.handler = serverless(app);
