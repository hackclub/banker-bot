import { App, SlashCommand, SayFn } from "@slack/bolt";
import { giveParse } from './parsing';

export const giveCommand = async (req: SlashCommand, say: SayFn) => {
    const parsed = await giveParse(req.text)

}