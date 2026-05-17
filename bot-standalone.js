// ============================================================
// BOT DO DISCORD - PIX QR CODE
// ============================================================
// Como usar:
//   1. Instale as dependências: npm install discord.js qrcode
//   2. Crie um arquivo .env com: DISCORD_TOKEN=seu_token_aqui
//   3. Rode: node bot-standalone.js
// ============================================================

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  AttachmentBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const QRCode = require("qrcode");
const { randomUUID } = require("node:crypto");
const { readFileSync, writeFileSync, existsSync } = require("node:fs");

// ============================================================
// CONFIGURAÇÕES — edite aqui
// ============================================================
const PIX_KEY = "02292209-3278-4cb2-862a-fca564e19440";
const MERCHANT_CITY = "BRASIL";
const AVALIACOES_CHANNEL_ID = "1389605705941778452";
const CONFIG_FILE = "./bot-config.json";
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
// ============================================================

if (!DISCORD_TOKEN) {
  console.error("❌ Defina a variável DISCORD_TOKEN antes de iniciar o bot.");
  process.exit(1);
}

const pendingPayments = new Map();

function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return {};
  try { return JSON.parse(readFileSync(CONFIG_FILE, "utf-8")); } catch { return {}; }
}

function saveConfig(config) {
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function buildPixPayload(valor, nome) {
  const merchantName = nome.substring(0, 25).toUpperCase();

  function field(id, value) {
    return `${id}${value.length.toString().padStart(2, "0")}${value}`;
  }

  const merchantAccountInfo = field("00", "BR.GOV.BCB.PIX") + field("01", PIX_KEY);

  let payload =
    field("00", "01") +
    field("26", merchantAccountInfo) +
    field("52", "0000") +
    field("53", "986") +
    field("54", valor.toFixed(2)) +
    field("58", "BR") +
    field("59", merchantName) +
    field("60", MERCHANT_CITY) +
    field("62", field("05", "***")) +
    "6304";

  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
    }
  }

  return payload + (crc & 0xffff).toString(16).toUpperCase().padStart(4, "0");
}

function isAdminOrOwner(interaction) {
  const isOwner = interaction.guild?.ownerId === interaction.user.id;
  const isAdmin =
    interaction.member &&
    typeof interaction.member.permissions !== "string" &&
    interaction.member.permissions.has(PermissionFlagsBits.Administrator);
  return isOwner || !!isAdmin;
}

function formatDateTime() {
  return new Date().toLocaleString("pt-BR", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

const commands = [
  new SlashCommandBuilder()
    .setName("pix")
    .setDescription("Gera um QR Code PIX para receber pagamento")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addNumberOption((opt) =>
      opt.setName("valor").setDescription("Valor em reais (ex: 50.00)").setRequired(true).setMinValue(0.01)
    )
    .addStringOption((opt) =>
      opt.setName("cliente").setDescription("Digite o nome do cliente para buscar no servidor").setRequired(true).setAutocomplete(true)
    )
    .addStringOption((opt) =>
      opt.setName("produto").setDescription("Nome do produto comprado (ex: kitsune)").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("setar-canal")
    .setDescription("Define o canal onde os logs de entrega serão enviados")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption((opt) =>
      opt.setName("canal").setDescription("Canal de texto para logs de entrega").setRequired(true)
    ),
];

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

client.once("clientReady", async (c) => {
  console.log(`✅ Bot conectado como ${c.user.tag}`);
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(c.user.id), {
    body: commands.map((cmd) => cmd.toJSON()),
  });
  console.log("✅ Comandos /pix e /setar-canal registrados");
});

client.on("interactionCreate", async (interaction) => {
  // Autocomplete
  if (interaction.isAutocomplete() && interaction.commandName === "pix") {
    const focusedValue = interaction.options.getFocused().toLowerCase();
    if (!interaction.guild) return interaction.respond([]);
    try {
      const members = await interaction.guild.members.fetch({ limit: 1000 });
      const choices = members
        .filter((m) =>
          m.user.username.toLowerCase().includes(focusedValue) ||
          (m.displayName ?? "").toLowerCase().includes(focusedValue)
        )
        .first(25)
        .map((m) => ({
          name: m.displayName !== m.user.username ? `${m.displayName} (${m.user.username})` : m.user.username,
          value: `${m.displayName}|${m.user.username}|${m.id}`,
        }));
      await interaction.respond(choices);
    } catch { await interaction.respond([]); }
    return;
  }

  // Comando /pix
  if (interaction.isChatInputCommand() && interaction.commandName === "pix") {
    if (!isAdminOrOwner(interaction)) {
      return interaction.reply({ content: "❌ Apenas o dono e administradores podem usar este comando.", ephemeral: true });
    }
    await interaction.deferReply();
    try {
      const valor = interaction.options.getNumber("valor", true);
      const clienteRaw = interaction.options.getString("cliente", true);
      const produto = interaction.options.getString("produto", true);

      let nome = clienteRaw, clienteId, clienteAvatarUrl;
      if (clienteRaw.includes("|")) {
        const parts = clienteRaw.split("|");
        nome = parts[0] ?? clienteRaw;
        clienteId = parts[2];
        if (clienteId) {
          try {
            const member = await interaction.guild?.members.fetch(clienteId);
            clienteAvatarUrl = member?.user.displayAvatarURL({ size: 256, extension: "png" });
          } catch {}
        }
      }

      const pixPayload = buildPixPayload(valor, nome);
      const qrBuffer = await QRCode.toBuffer(pixPayload, {
        errorCorrectionLevel: "M", type: "png", width: 512, margin: 2,
        color: { dark: "#000000", light: "#ffffff" },
      });

      const paymentId = randomUUID().slice(0, 8);
      pendingPayments.set(paymentId, {
        valor, nome, produto, clienteId, clienteAvatarUrl,
        adminUsername: interaction.user.username,
      });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`pix_confirm:${paymentId}`)
          .setLabel("✅ Confirmar Pagamento")
          .setStyle(ButtonStyle.Success)
      );

      await interaction.editReply({
        content:
          `## 💸 QR Code PIX\n` +
          `> **Cliente:** ${nome}\n` +
          `> **Produto:** ${produto}\n` +
          `> **Valor:** R$ ${valor.toFixed(2).replace(".", ",")}\n\n` +
          `**Copia e cola:**\n\`\`\`\n${pixPayload}\n\`\`\``,
        files: [new AttachmentBuilder(qrBuffer, { name: "pix.png" })],
        components: [row],
      });
    } catch (err) {
      console.error(err);
      await interaction.editReply("❌ Erro ao gerar o QR Code.");
    }
    return;
  }

  // Comando /setar-canal
  if (interaction.isChatInputCommand() && interaction.commandName === "setar-canal") {
    if (!isAdminOrOwner(interaction)) {
      return interaction.reply({ content: "❌ Apenas o dono e administradores podem usar este comando.", ephemeral: true });
    }
    const canal = interaction.options.getChannel("canal", true);
    const guildId = interaction.guildId;
    if (!guildId) return interaction.reply({ content: "❌ Erro ao identificar o servidor.", ephemeral: true });
    const config = loadConfig();
    config[`canal_${guildId}`] = canal.id;
    saveConfig(config);
    return interaction.reply({ content: `✅ Canal de logs definido como <#${canal.id}>!`, ephemeral: true });
  }

  // Botão confirmar pagamento
  if (interaction.isButton() && interaction.customId.startsWith("pix_confirm:")) {
    if (!isAdminOrOwner(interaction)) {
      return interaction.reply({ content: "❌ Apenas administradores podem confirmar pagamentos.", ephemeral: true });
    }
    const paymentId = interaction.customId.split(":")[1];
    const payment = pendingPayments.get(paymentId);
    if (!payment) {
      return interaction.reply({ content: "❌ Pagamento não encontrado ou já confirmado.", ephemeral: true });
    }
    await interaction.deferUpdate();
    try {
      const config = loadConfig();
      const canalId = config[`canal_${interaction.guildId}`];
      const valorFormatado = `R$ ${payment.valor.toFixed(2).replace(".", ",")}`;

      if (canalId) {
        const canal = interaction.guild?.channels.cache.get(canalId);
        if (canal) {
          const compradorDisplay = payment.clienteId
            ? `${payment.nome} (<@${payment.clienteId}>)`
            : payment.nome;

          const embed = new EmbedBuilder()
            .setColor(0x2b2d31)
            .setAuthor({ name: payment.nome, iconURL: payment.clienteAvatarUrl })
            .setThumbnail(payment.clienteAvatarUrl ?? null)
            .addFields(
              { name: "✅ Pagamento Confirmado", value: "\u200b", inline: false },
              { name: "Produto", value: payment.produto, inline: true },
              { name: "Valor", value: valorFormatado, inline: true },
              { name: "Comprador", value: compradorDisplay, inline: false },
              { name: "Chave Pix", value: PIX_KEY, inline: false },
              { name: "\u200b", value: formatDateTime(), inline: false }
            );

          const logRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setLabel("⭐ Avaliações do servidor")
              .setStyle(ButtonStyle.Link)
              .setURL(`https://discord.com/channels/${interaction.guildId}/${AVALIACOES_CHANNEL_ID}`)
          );

          await canal.send({ embeds: [embed], components: [logRow] });
        }
      }

      pendingPayments.delete(paymentId);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`pix_done:${paymentId}`)
          .setLabel("✅ Pagamento Confirmado")
          .setStyle(ButtonStyle.Success)
          .setDisabled(true)
      );

      await interaction.editReply({
        content:
          (interaction.message.content ?? "") +
          `\n\n✅ **Confirmado por <@${interaction.user.id}>!**` +
          (canalId ? ` Log em <#${canalId}>.` : "\n⚠️ Use /setar-canal para configurar o canal de logs."),
        components: [row],
      });
    } catch (err) {
      console.error(err);
      await interaction.followUp({ content: "❌ Erro ao confirmar o pagamento.", ephemeral: true });
    }
  }
});

client.on("error", console.error);
client.login(DISCORD_TOKEN);
const http = require("http");

http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Bot online");
}).listen(process.env.PORT || 3000);
