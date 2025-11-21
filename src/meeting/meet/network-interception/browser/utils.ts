// Browser-side utility functions

import type { MessageDecoders, ProtobufReader, RawUser } from '../types'

// --- Encoding/Decoding Helpers ---

export function base64ToUint8Array(base64: string): Uint8Array {
    const binaryString = window.atob(base64)
    const len = binaryString.length
    const bytes = new Uint8Array(len)
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i)
    }
    return bytes
}

// --- Protobuf Decoder Factory ---

export function createMessageDecoder(messageType: any) {
    return function decode(
        readerOrBuffer: ProtobufReader | Uint8Array,
        length?: number,
    ): any {
        // Convert to ProtobufReader if needed
        const reader: ProtobufReader = (
            readerOrBuffer instanceof (window as any).protobuf.Reader
                ? readerOrBuffer
                : (window as any).protobuf.Reader.create(readerOrBuffer)
        ) as ProtobufReader

        const end = length === undefined ? reader.len : reader.pos + length
        const message: any = {}

        while (reader.pos < end) {
            const tag = reader.uint32()
            const fieldNumber = tag >>> 3

            const field = messageType.fields.find(
                (f: any) => f.fieldNumber === fieldNumber,
            )
            if (!field) {
                reader.skipType(tag & 7)
                continue
            }

            let value
            switch (field.type) {
                case 'string':
                    value = reader.string()
                    break
                case 'int64':
                    value = reader.int64()
                    break
                case 'varint':
                    value = reader.uint32()
                    break
                case 'bytes':
                    value = reader.bytes()
                    break
                case 'message':
                    const messageDecoders = (window as any)
                        .__networkMessageDecoders
                    value = messageDecoders[field.messageType](
                        reader,
                        reader.uint32(),
                    )
                    break
                default:
                    reader.skipType(tag & 7)
                    continue
            }

            if (field.repeated) {
                if (!message[field.name]) {
                    message[field.name] = []
                }
                message[field.name].push(value)
            } else {
                message[field.name] = value
            }
        }

        return message
    }
}

export function createDecoders(schema: any[]): MessageDecoders {
    const messageDecoders: MessageDecoders = {}

    // Store globally so createMessageDecoder can access it
    ;(window as any).__networkMessageDecoders = messageDecoders

    schema.forEach((type: any) => {
        messageDecoders[type.name] = createMessageDecoder(type)
    })

    return messageDecoders
}

// --- User Name Decoder ---

export function decodeUserName(user: RawUser): string {
    if (user.displayName) return user.displayName
    if (user.fullName) {
        if (user.fullName instanceof Uint8Array) {
            try {
                return new TextDecoder().decode(user.fullName)
            } catch {
                return 'Unknown'
            }
        }
        return user.fullName
    }
    return 'Unknown'
}
