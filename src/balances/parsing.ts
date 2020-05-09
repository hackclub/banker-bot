export /**
 * A function that parses the balance command
 *
 * @param {string} text The text that was included in the command.
 * @param {string} from This is used in case it is a self-referencing balance request.
 * @returns {string} The user whose balance needs to be checked.
 */
const parseBalance = (text: string, from: string): string  => {
    if (text.replace(/^\s+/, '').replace(/\s+$/, '') === '' || text === "me") {
        return from
    }

    else {
        return text.replace(/@|<|>|/g, "")
    }
}