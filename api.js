const express = require('express');
const axios = require('axios');
const cors = require('cors');
const serverless = require('serverless-http');

const app = express();

app.use(cors());
app.use(express.json());

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
      customer: {
        document: { number: cpf, type: "cpf" },
        name: nome,
        email,
        phone: celular
      },
      shipping: { fee: 0 },
      amount: intValor,
      paymentMethod: "pix",
      items: [
        {
          tangible: true,
          title: produto,
          unitPrice: intValor,
          quantity: 1
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

    res.json({
      qrCodeImage: response.data?.pix?.qrCodeImage,
      txid: response.data?.pix?.txid,
      raw: response.data
    });

  } catch (err) {
    console.error("💥 ERRO AO GERAR PIX:", err.response?.data || err.message);
    res.status(500).json({ error: "Erro ao gerar Pix", details: err.response?.data || err.message });
  }
});

// 🧨 NÃO roda localmente na Vercel com app.listen
// app.listen(3000, () => console.log("🔥 rodando em http://localhost:3000"));

// 🔥 Exportação pro ritual Serverless
module.exports = app;
module.exports.handler = serverless(app);
