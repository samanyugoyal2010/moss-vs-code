"""A small Discord bot that indexes messages in Moss and searches them semantically."""

from __future__ import annotations

import os
import sys
from typing import Final

import discord
from discord.ext import commands
from dotenv import load_dotenv
from moss import DocumentInfo, MossClient, QueryOptions

REQUIRED_ENV: Final = (
    "DISCORD_BOT_TOKEN",
    "MOSS_PROJECT_ID",
    "MOSS_PROJECT_KEY",
    "MOSS_INDEX_NAME",
)


def build_document(message: discord.Message, text: str | None = None) -> DocumentInfo:
    """Convert a Discord message into a Moss document with useful source metadata."""
    return DocumentInfo(
        id=str(message.id),
        text=text if text is not None else message.content,
        metadata={
            "channel_id": str(message.channel.id),
            "channel_name": getattr(message.channel, "name", "unknown"),
            "author_id": str(message.author.id),
            "author_name": str(message.author),
            "url": message.jump_url,
        },
    )


class MossDiscordBot(commands.Bot):
    """Discord bot that writes messages to and searches one Moss index."""

    def __init__(self, moss: MossClient, index_name: str) -> None:
        intents = discord.Intents.default()
        intents.message_content = True
        super().__init__(command_prefix="!", intents=intents)
        self.moss = moss
        self.index_name = index_name
        self.index_exists = False

    async def setup_hook(self) -> None:
        """Register commands and detect whether the configured index already exists."""
        indexes = await self.moss.list_indexes()
        self.index_exists = any(index.name == self.index_name for index in indexes)

    async def add_message_to_index(self, message: discord.Message, text: str | None = None) -> None:
        """Create the index on first use, then append subsequent messages."""
        text = text if text is not None else message.content
        if not text.strip():
            return
        document = build_document(message, text)
        if self.index_exists:
            await self.moss.add_docs(self.index_name, [document])
        else:
            await self.moss.create_index(self.index_name, [document], "moss-minilm")
            self.index_exists = True


def create_bot() -> MossDiscordBot:
    """Build a configured bot, failing early with a useful message if setup is incomplete."""
    load_dotenv()
    missing = [name for name in REQUIRED_ENV if not os.getenv(name)]
    if missing:
        raise RuntimeError(f"Missing required environment variables: {', '.join(missing)}")

    moss = MossClient(os.environ["MOSS_PROJECT_ID"], os.environ["MOSS_PROJECT_KEY"])
    bot = MossDiscordBot(moss, os.environ["MOSS_INDEX_NAME"])

    @bot.event
    async def on_ready() -> None:
        print(f"Logged in as {bot.user}; Moss index: {bot.index_name}")

    @bot.command(name="moss-index")
    @commands.has_guild_permissions(manage_messages=True)
    async def index_message(ctx: commands.Context[commands.Bot], *, text: str) -> None:
        """Index explicit knowledge text: !moss-index The refund policy is ..."""
        await bot.add_message_to_index(ctx.message, text)
        await ctx.send("Indexed that knowledge in Moss.")

    @bot.command(name="ask")
    async def ask(ctx: commands.Context[commands.Bot], *, question: str) -> None:
        """Search Moss and return the most relevant indexed messages."""
        if not bot.index_exists:
            await ctx.send("The Moss index is empty. Ask a moderator to run `!moss-index <text>`.")
            return
        results = await bot.moss.query(bot.index_name, question, QueryOptions(top_k=3))
        if not results.docs:
            await ctx.send("I couldn't find anything relevant in the Moss index.")
            return
        lines = [f"**{result.score:.2f}** {result.text}" for result in results.docs]
        await ctx.send("\n".join(lines)[:2000])

    return bot


if __name__ == "__main__":
    try:
        create_bot().run(os.environ["DISCORD_BOT_TOKEN"])
    except RuntimeError as error:
        print(error, file=sys.stderr)
        raise SystemExit(1) from error
