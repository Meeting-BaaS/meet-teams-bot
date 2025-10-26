export namespace ApiTypes {
  export type GetableBot = {
    bot: QueryableBot
    params: Record<string, unknown> // Unused key/values
    duration: number
  }

  export type QueryableBot = {
    id: number
    // Unused key/values
  }

  export type PostableTranscript = {
    speaker: string
    start_time: number
    end_time: number | null
    lang: string | null
  }

  export type QueryableTranscript = {
    id: number
    bot_id: number
    speaker: string
    start_time: number
    end_time: number | null
    lang: string | null
  }

  export type ChangeableTranscript = {
    id: number
    end_time: number
  }
}
