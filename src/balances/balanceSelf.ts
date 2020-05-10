import Axios, { AxiosResponse } from "axios"
import { environment } from '../../environment';
import { SlashCommand, SayFn, SayArguments } from '@slack/bolt';
import { parseBalance } from "./parsing";

const balanceRequest = async (userId: string) => {
    return Axios.get(environment["endpoint"] + '/balance', {
        params: {
            user: userId
        }
    })
}

export const balanceCommand = async (req: SlashCommand, say: SayFn) => {
    const { text, user_id } = req

    // the ge
    const user: string = await parseBalance(text, user_id);

    // Gets the request from the database.
    const balance: AxiosResponse<number> = (await balanceRequest(user)).data;
    
    await say({
        blocks: [
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: `Balance of ${user}: *${balance}* gp`
                }
            },
            {
                "type": "context",
                "elements": [
                    {
                        "type": "mrkdwn",
                        "text": `Requested by: <@${req.user_name}>`
                    }
                ],
            }
        ]
    } as SayArguments)
}