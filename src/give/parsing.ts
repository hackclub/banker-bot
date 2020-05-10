/**
 * An interface for the `/give` request response.
 */
interface GiveRequest {
    to: string,
    amount: number,
    note?: string
}


/**
 * A parser for the give function. This just returns an object conforming to [[GiveRequest]]
 * @param text The text that was given in the `give` slash command.
 */
export const giveParse = (text: string): GiveRequest => {

    const split = text.split(" ");

    // Should work with and without "gp"
    const amount = parseInt(split[1].replace("gp", ""));

    let returnObj = {
        to: split[0],
        amount: amount
    }

    // There doesn't necessarily need to be a note.
    if (split.includes("for")) {
        let note = split.slice(split.indexOf("for")).join(" ")

        Object.assign(returnObj, {
            note: note
        })
    }

    return returnObj

}