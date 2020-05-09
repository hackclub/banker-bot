import Axios from "axios"
import { environment } from '../../environment';
import { SlashCommand, SayFn } from '@slack/bolt';
import { parseBalance } from "./parsing";

const balanceRequest = async (userId: string) => {
    return Axios.get(environment["endpoint"] + '/balance', {
        params: {
            user: userId
        }
    })
}

export const balanceCommand = async (req: SlashCommand, say: SayFn) => {
    const user = await parseBalance(req.text, req.user_id);
    const balance = await balanceRequest(user);
}